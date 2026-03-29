# 📚 PDF Compressor

A fully client-side web application to aggressively compress and optimize PDF files directly in your browser. 

## 🌟 Why this tool?
Most online PDF compressors require you to upload your potentially sensitive documents (like work presentations, financial reports, or IDs) to a remote server. This poses a massive privacy and security risk. 

**PDF Compressor** processes everything 100% locally in your web browser using a WebAssembly port of Ghostscript. Your files never leave your device, ensuring total privacy.

## ✨ Features
* **Zero Uploads:** Complete client-side processing. No servers, no tracking.
* **Smart Waterfall Algorithm:** Intelligently retries different compression levels if the file doesn't shrink enough, guaranteeing the best size-to-quality ratio without user guesswork.
* **Pro-Level Optimization:** Utilizes industry-standard distilling parameters (DPI downsampling, image deduplication, and RGB color space conversion) to drastically reduce file size while keeping text fully selectable and crisp.
* **Performance Focused:** The heavy compression engine runs in a dedicated Web Worker, ensuring the UI remains smooth and responsive.
* **Modern UI:** Clean, minimalist, and user-friendly interface with native Dark Mode support.

## 🛠️ Technology Stack
* **Frontend:** Vanilla HTML5, CSS3, and JavaScript (No heavy frameworks or build tools).
* **PDF Engine:** WebAssembly port of Ghostscript (`gs-worker.wasm`), executed on-demand via Web Workers.
* **Hosting:** Vercel (Static deployment).

## 🚀 How to Use
1. Drag and drop a large PDF into the drop zone.
2. Select your desired compression level (Extreme, Recommended, or High Quality).
3. Click "Compress PDF" and let the local WASM engine optimize it.
4. Download or share your heavily compressed PDF.

## 📜 License
This project is open-source and free to use.