FROM node:20-alpine

# poppler-utils: pdftotext -layout + pdffonts for the LP report PDF ingest
# (src/jobs/lp-report-ingest.js). The pdffonts pass is the text-layer
# assertion — scanned PDFs are rejected, never OCR'd.
#
# ffmpeg: transcodes Five9 call recordings to MP3 (src/ci/recordings.js).
# Five9 writes WAVE format tag 0x0031 — GSM 6.10, 8 kHz, mono — which Chrome,
# Safari, Firefox and QuickTime all refuse to decode, so a rep clicking a
# recording link gets nothing. Without ffmpeg the pipeline still runs and links
# still resolve, they just serve the unplayable original; the service says so
# loudly at startup rather than crashing (see logFfmpegStatus()).
RUN apk add --no-cache poppler-utils ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 8080

CMD ["node", "src/index.js"]
