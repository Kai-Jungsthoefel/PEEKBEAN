/* SPDX-License-Identifier: GPL-3.0-or-later */
/*
 * Minimal read-only libarchive API for the WebAssembly build used by Everything Viewer.
 *
 * A handle owns one in-memory copy of an archive. ar_open() lists all regular files once; ar_extract()
 * decompresses one entry into a malloc'd buffer that the caller frees. Extracting entries in ascending order
 * reuses the open reader, so walking a solid 7z/RAR archive does not restart from the beginning every time.
 *
 * Nothing here aborts: every failure is reported as a message string (ar_error), usually libarchive's own
 * archive_error_string(). Build: scripts/build-libarchive-wasm.mjs. JS API: src/wasm/libarchive/.
 */
#include <locale.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "archive.h"
#include "archive_entry.h"

#define AR_EXPORT EMSCRIPTEN_KEEPALIVE

/* Bits of ar_entry_flags(). Keep in sync with libarchive-reader.js. */
#define AR_FLAG_ENCRYPTED 1u /* data or metadata is encrypted */
#define AR_FLAG_SIZE_SET 2u  /* ar_entry_size() is known */
#define AR_FLAG_MTIME_SET 4u /* ar_entry_mtime() is known */
#define AR_FLAG_RAW_PATH 8u  /* path could not be converted to UTF-8; these are the archive's raw bytes */
#define AR_FLAG_HARDLINK 16u /* entry is a hard link to ar_entry_hardlink() (tar/cpio store data only once) */

/* libarchive returns ARCHIVE_RETRY for headers it skipped; give up after this many in a row. */
#define AR_MAX_RETRIES 1000

/* ar_extract() allocates the declared entry size up front only up to max(this, 32 x archive size). */
#define AR_MIN_PREALLOC_LIMIT ((size_t)64 * 1024 * 1024)

typedef struct {
	uint32_t header; /* position among all headers (directories, links, ...) of the archive */
	uint32_t flags;
	double size;
	double mtime;
	char *path;
	char *hardlink;
} ar_entry;

typedef struct {
	unsigned char *data; /* the archive, owned */
	size_t data_size;
	char **passphrases;
	size_t passphrase_count;
	int raw; /* read as one compressed stream (format "raw"), e.g. notes.txt.xz */

	ar_entry *entries;
	size_t count;
	size_t capacity;

	char *error;   /* last error, NULL if the last call succeeded */
	char *warning; /* listing stopped early (damaged or truncated archive) */
	char *format;
	char *filters;

	/* Reader kept open between ar_extract() calls. */
	struct archive *cursor;
	struct archive_entry *cursor_entry; /* valid until the cursor moves on */
	long cursor_header;   /* header the cursor stands on, -1 before the first */
	int cursor_has_data;  /* its data has not been read yet */
	size_t extracted_size;
} ar_handle;

static char *dup_string(const char *s)
{
	size_t n;
	char *copy;

	if (s == NULL)
		return NULL;
	n = strlen(s) + 1;
	copy = malloc(n);
	if (copy != NULL)
		memcpy(copy, s, n);
	return copy;
}

static void set_error(ar_handle *h, const char *message)
{
	free(h->error);
	h->error = dup_string(message != NULL && *message ? message : "Unknown error");
	if (h->error == NULL)
		h->error = dup_string("Out of memory");
}

static void set_archive_error(ar_handle *h, struct archive *a, const char *fallback)
{
	const char *message = a != NULL ? archive_error_string(a) : NULL;
	set_error(h, message != NULL && *message ? message : fallback);
}

static void clear_error(ar_handle *h)
{
	free(h->error);
	h->error = NULL;
}

static void ensure_locale(void)
{
	static int done = 0;

	/* libarchive converts names to the locale's charset; make that UTF-8 instead of ASCII. */
	if (!done) {
		setlocale(LC_ALL, "C.UTF-8");
		done = 1;
	}
}

static struct archive *new_reader(ar_handle *h, int raw)
{
	struct archive *a = archive_read_new();
	size_t i;

	if (a == NULL)
		return NULL;
	if (raw) {
		archive_read_support_format_raw(a);
	} else {
		/* Everything libarchive reads except mtree (refers to files on disk) and "empty". */
		archive_read_support_format_7zip(a);
		archive_read_support_format_ar(a);
		archive_read_support_format_cab(a);
		archive_read_support_format_cpio(a);
		archive_read_support_format_iso9660(a);
		archive_read_support_format_lha(a);
		archive_read_support_format_rar(a);
		archive_read_support_format_rar5(a);
		archive_read_support_format_tar(a);
		archive_read_support_format_warc(a);
		archive_read_support_format_xar(a); /* returns ARCHIVE_WARN without an XML parser */
		archive_read_support_format_zip(a);
	}
	/* Built-in decoders only; grzip/lrzip/lzop would need external programs. */
	archive_read_support_filter_bzip2(a);
	archive_read_support_filter_compress(a);
	archive_read_support_filter_gzip(a);
	archive_read_support_filter_lz4(a);
	archive_read_support_filter_lzip(a);
	archive_read_support_filter_lzma(a);
	archive_read_support_filter_rpm(a);
	archive_read_support_filter_uu(a);
	archive_read_support_filter_xz(a);
	archive_read_support_filter_zstd(a);
	for (i = 0; i < h->passphrase_count; i++)
		archive_read_add_passphrase(a, h->passphrases[i]);
	return a;
}

/* Opens a reader on the handle's data. On failure returns NULL and sets the handle's error. */
static struct archive *open_reader(ar_handle *h, int raw)
{
	struct archive *a = new_reader(h, raw);

	if (a == NULL) {
		set_error(h, "Out of memory");
		return NULL;
	}
	if (archive_read_open_memory(a, h->data, h->data_size) != ARCHIVE_OK) {
		set_archive_error(h, a, "Cannot open archive");
		archive_read_free(a);
		return NULL;
	}
	return a;
}

/* archive_read_next_header() without ARCHIVE_RETRY: returns ARCHIVE_OK, _WARN, _EOF or _FATAL. */
static int next_header(struct archive *a, struct archive_entry **entry)
{
	int retries = 0;
	int r;

	do {
		r = archive_read_next_header(a, entry);
	} while (r == ARCHIVE_RETRY && ++retries < AR_MAX_RETRIES);
	if (r == ARCHIVE_RETRY || r == ARCHIVE_FAILED)
		r = ARCHIVE_FATAL;
	return r;
}

static void close_cursor(ar_handle *h)
{
	if (h->cursor != NULL)
		archive_read_free(h->cursor);
	h->cursor = NULL;
	h->cursor_entry = NULL;
	h->cursor_header = -1;
	h->cursor_has_data = 0;
}

static int add_entry(ar_handle *h, uint32_t header, struct archive_entry *entry)
{
	ar_entry *e;
	const char *path;
	const char *link;
	uint32_t flags = 0;

	if (h->count == h->capacity) {
		size_t capacity = h->capacity ? h->capacity * 2 : 64;
		ar_entry *grown = realloc(h->entries, capacity * sizeof(*grown));

		if (grown == NULL)
			return -1;
		h->entries = grown;
		h->capacity = capacity;
	}
	path = archive_entry_pathname_utf8(entry);
	if (path == NULL) {
		path = archive_entry_pathname(entry);
		flags |= AR_FLAG_RAW_PATH;
	}
	link = archive_entry_hardlink_utf8(entry);
	if (link == NULL)
		link = archive_entry_hardlink(entry);

	e = &h->entries[h->count];
	memset(e, 0, sizeof(*e));
	e->header = header;
	e->path = dup_string(path != NULL ? path : "");
	if (e->path == NULL)
		return -1;
	if (link != NULL) {
		e->hardlink = dup_string(link);
		if (e->hardlink == NULL) {
			free(e->path);
			return -1;
		}
		flags |= AR_FLAG_HARDLINK;
	}
	if (archive_entry_is_encrypted(entry))
		flags |= AR_FLAG_ENCRYPTED;
	if (archive_entry_size_is_set(entry)) {
		flags |= AR_FLAG_SIZE_SET;
		e->size = (double)archive_entry_size(entry);
	}
	if (archive_entry_mtime_is_set(entry)) {
		flags |= AR_FLAG_MTIME_SET;
		e->mtime = (double)archive_entry_mtime(entry);
	}
	e->flags = flags;
	h->count++;
	return 0;
}

/* Some readers (WARC) never set a format name. */
static const char *base_format_name(int code)
{
	switch (code & ARCHIVE_FORMAT_BASE_MASK) {
	case ARCHIVE_FORMAT_CPIO: return "cpio";
	case ARCHIVE_FORMAT_TAR: return "tar";
	case ARCHIVE_FORMAT_ISO9660: return "ISO9660";
	case ARCHIVE_FORMAT_ZIP: return "ZIP";
	case ARCHIVE_FORMAT_AR: return "ar";
	case ARCHIVE_FORMAT_XAR: return "xar";
	case ARCHIVE_FORMAT_LHA: return "lha";
	case ARCHIVE_FORMAT_CAB: return "CAB";
	case ARCHIVE_FORMAT_RAR: return "RAR";
	case ARCHIVE_FORMAT_7ZIP: return "7-Zip";
	case ARCHIVE_FORMAT_WARC: return "WARC";
	case ARCHIVE_FORMAT_RAR_V5: return "RAR5";
	default: return "";
	}
}

static void describe(ar_handle *h, struct archive *a)
{
	char filters[256] = "";
	int count = archive_filter_count(a);
	const char *format = archive_format_name(a);
	int i;

	free(h->format);
	h->format = dup_string(format != NULL && *format ? format : base_format_name(archive_format(a)));
	/* Filter 0 is the outermost compression; the last one is always "none". */
	for (i = 0; i < count; i++) {
		const char *name = archive_filter_name(a, i);

		if (name == NULL || archive_filter_code(a, i) == ARCHIVE_FILTER_NONE)
			continue;
		if (filters[0] != '\0')
			strncat(filters, ",", sizeof(filters) - strlen(filters) - 1);
		strncat(filters, name, sizeof(filters) - strlen(filters) - 1);
	}
	free(h->filters);
	h->filters = dup_string(filters);
}

/* Reads all headers once and records the regular files. */
static void list_entries(ar_handle *h, struct archive *a)
{
	struct archive_entry *entry;
	uint32_t header = 0;
	int r;

	for (;;) {
		r = next_header(a, &entry);
		if (r == ARCHIVE_EOF)
			break;
		if (r == ARCHIVE_FATAL) {
			if (header == 0) {
				set_archive_error(h, a, "Cannot read archive");
			} else {
				free(h->warning);
				h->warning = dup_string(archive_error_string(a) != NULL ? archive_error_string(a) : "Archive is damaged");
			}
			break;
		}
		if (header == 0)
			describe(h, a);
		if (archive_entry_filetype(entry) == AE_IFREG && add_entry(h, header, entry) != 0) {
			set_error(h, "Out of memory");
			break;
		}
		header++;
	}
	if (header == 0 && h->error == NULL)
		describe(h, a);
}

/*
 * Takes ownership of `data` (allocated with malloc) and lists the archive. Returns NULL only when out of
 * memory; otherwise check ar_error(). `passphrase` may be NULL.
 */
AR_EXPORT ar_handle *ar_open(unsigned char *data, size_t size, const char *passphrase)
{
	ar_handle *h = calloc(1, sizeof(*h));
	struct archive *a;

	if (h == NULL) {
		free(data);
		return NULL;
	}
	ensure_locale();
	h->data = data;
	h->data_size = size;
	h->cursor_header = -1;
	if (passphrase != NULL && *passphrase) {
		h->passphrases = malloc(sizeof(char *));
		if (h->passphrases == NULL || (h->passphrases[0] = dup_string(passphrase)) == NULL) {
			set_error(h, "Out of memory");
			return h;
		}
		h->passphrase_count = 1;
	}
	if (size == 0) {
		set_error(h, "The file is empty");
		return h;
	}

	a = open_reader(h, 0);
	if (a == NULL) {
		/*
		 * Not an archive format: maybe a single compressed file (.xz, .bz2, .lzma, .zst, ...). The raw
		 * format accepts any input, so only take it if a compression filter recognized the data.
		 */
		char *original = dup_string(h->error);
		struct archive *raw = open_reader(h, 1);

		if (raw != NULL && archive_filter_code(raw, 0) != ARCHIVE_FILTER_NONE) {
			clear_error(h);
			h->raw = 1;
			a = raw;
		} else {
			if (raw != NULL)
				archive_read_free(raw);
			set_error(h, original != NULL ? original : "Unrecognized archive format");
		}
		free(original);
		if (a == NULL)
			return h;
	}
	list_entries(h, a);
	archive_read_free(a);
	return h;
}

AR_EXPORT void ar_close(ar_handle *h)
{
	size_t i;

	if (h == NULL)
		return;
	close_cursor(h);
	for (i = 0; i < h->count; i++) {
		free(h->entries[i].path);
		free(h->entries[i].hardlink);
	}
	for (i = 0; i < h->passphrase_count; i++)
		free(h->passphrases[i]);
	free(h->passphrases);
	free(h->entries);
	free(h->error);
	free(h->warning);
	free(h->format);
	free(h->filters);
	free(h->data);
	free(h);
}

AR_EXPORT const char *ar_error(ar_handle *h) { return h->error; }
AR_EXPORT const char *ar_warning(ar_handle *h) { return h->warning; }
AR_EXPORT const char *ar_format(ar_handle *h) { return h->raw ? "raw" : (h->format ? h->format : ""); }
AR_EXPORT const char *ar_filters(ar_handle *h) { return h->filters ? h->filters : ""; }
AR_EXPORT uint32_t ar_count(ar_handle *h) { return (uint32_t)h->count; }

#define ENTRY_GETTER(type, name, expr, fallback) \
	AR_EXPORT type name(ar_handle *h, uint32_t i) { return i < h->count ? (expr) : (fallback); }
ENTRY_GETTER(uint32_t, ar_entry_header, h->entries[i].header, 0)
ENTRY_GETTER(uint32_t, ar_entry_flags, h->entries[i].flags, 0)
ENTRY_GETTER(double, ar_entry_size, h->entries[i].size, 0)
ENTRY_GETTER(double, ar_entry_mtime, h->entries[i].mtime, 0)
ENTRY_GETTER(const char *, ar_entry_path, h->entries[i].path, NULL)
ENTRY_GETTER(const char *, ar_entry_hardlink, h->entries[i].hardlink, NULL)

/* Adds a passphrase for later ar_extract() calls (libarchive tries all of them). Returns 0 or -1. */
AR_EXPORT int ar_add_passphrase(ar_handle *h, const char *passphrase)
{
	char **grown;
	size_t i;

	clear_error(h);
	if (passphrase == NULL || *passphrase == '\0')
		return 0;
	for (i = 0; i < h->passphrase_count; i++)
		if (strcmp(h->passphrases[i], passphrase) == 0)
			return 0;
	grown = realloc(h->passphrases, (h->passphrase_count + 1) * sizeof(char *));
	if (grown == NULL) {
		set_error(h, "Out of memory");
		return -1;
	}
	h->passphrases = grown;
	h->passphrases[h->passphrase_count] = dup_string(passphrase);
	if (h->passphrases[h->passphrase_count] == NULL) {
		set_error(h, "Out of memory");
		return -1;
	}
	h->passphrase_count++;
	/* Readers only see passphrases added before they were opened. */
	close_cursor(h);
	return 0;
}

/*
 * Decompresses the entry at position `header` (ar_entry_header(), not the list index) into a new malloc'd
 * buffer of ar_extracted_size() bytes, which the caller frees. Returns NULL on error (see ar_error()).
 */
AR_EXPORT unsigned char *ar_extract(ar_handle *h, uint32_t header)
{
	unsigned char *buffer;
	size_t capacity;
	size_t length = 0;
	int64_t declared = -1;
	size_t limit;

	clear_error(h);
	h->extracted_size = 0;
	if (h->data == NULL || h->data_size == 0) {
		set_error(h, "No archive data");
		return NULL;
	}
	/* Reuse the open reader when the entry comes later in the archive. */
	if (h->cursor == NULL || (long)header < h->cursor_header || ((long)header == h->cursor_header && !h->cursor_has_data)) {
		close_cursor(h);
		h->cursor = open_reader(h, h->raw);
		if (h->cursor == NULL)
			return NULL;
	}
	while (h->cursor_header < (long)header) {
		int r = next_header(h->cursor, &h->cursor_entry);

		if (r == ARCHIVE_EOF || r == ARCHIVE_FATAL) {
			if (r == ARCHIVE_EOF)
				set_error(h, "Entry not found");
			else
				set_archive_error(h, h->cursor, "Cannot read archive");
			close_cursor(h);
			return NULL;
		}
		h->cursor_header++;
		h->cursor_has_data = 1;
	}
	/*
	 * libarchive's RAR 4 reader cannot decrypt, yet it would hand out the ciphertext of stored entries (and
	 * odd decoder errors for compressed ones). Say what is going on instead.
	 */
	if (h->cursor_entry != NULL && archive_entry_is_data_encrypted(h->cursor_entry)
	    && (archive_format(h->cursor) & ARCHIVE_FORMAT_BASE_MASK) == ARCHIVE_FORMAT_RAR) {
		set_error(h, "RAR encryption support unavailable: encrypted entries cannot be decrypted");
		return NULL;
	}
	if (h->cursor_entry != NULL && archive_entry_size_is_set(h->cursor_entry))
		declared = archive_entry_size(h->cursor_entry);
	h->cursor_has_data = 0;

	if (declared > (int64_t)(SIZE_MAX / 2)) {
		set_error(h, "Entry is too large to extract in the browser");
		close_cursor(h);
		return NULL;
	}
	/*
	 * Trust the declared size, but not blindly: a damaged or hostile header must not make a tiny archive
	 * reserve gigabytes up front. Above the limit the buffer grows with the data actually decompressed.
	 */
	limit = h->data_size > SIZE_MAX / 32 ? SIZE_MAX : h->data_size * 32;
	if (limit < AR_MIN_PREALLOC_LIMIT)
		limit = AR_MIN_PREALLOC_LIMIT;
	capacity = declared < 0 ? 64 * 1024 : ((uint64_t)declared < limit ? (size_t)declared : limit);
	buffer = malloc(capacity > 0 ? capacity : 1);
	if (buffer == NULL) {
		set_error(h, "Out of memory");
		close_cursor(h);
		return NULL;
	}
	for (;;) {
		la_ssize_t n;

		if (length == capacity) {
			/* Probe for more data before growing, so entries of the declared size need no realloc. */
			unsigned char probe[4096];
			unsigned char *grown;

			n = archive_read_data(h->cursor, probe, sizeof(probe));
			if (n <= 0) {
				if (n < 0)
					goto fail;
				break;
			}
			if (capacity > SIZE_MAX / 2 - (size_t)n) {
				set_error(h, "Entry is too large to extract in the browser");
				goto fail_set;
			}
			capacity = capacity * 2 > capacity + (size_t)n ? capacity * 2 : capacity + (size_t)n;
			grown = realloc(buffer, capacity);
			if (grown == NULL) {
				set_error(h, "Out of memory");
				goto fail_set;
			}
			buffer = grown;
			memcpy(buffer + length, probe, (size_t)n);
			length += (size_t)n;
			continue;
		}
		n = archive_read_data(h->cursor, buffer + length, capacity - length);
		if (n < 0)
			goto fail;
		if (n == 0)
			break;
		length += (size_t)n;
	}
	h->extracted_size = length;
	return buffer;

fail:
	set_archive_error(h, h->cursor, "Cannot read entry data");
fail_set:
	free(buffer);
	close_cursor(h);
	return NULL;
}

AR_EXPORT size_t ar_extracted_size(ar_handle *h) { return h->extracted_size; }
