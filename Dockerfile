FROM node:20-alpine

# poppler-utils: pdftotext -layout + pdffonts for the LP report PDF ingest
# (src/jobs/lp-report-ingest.js). The pdffonts pass is the text-layer
# assertion — scanned PDFs are rejected, never OCR'd.
RUN apk add --no-cache poppler-utils

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 8080

CMD ["node", "src/index.js"]
