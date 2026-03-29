/**
 * PDF Compressor — on-demand workers + generic “best result” waterfall
 *
 * compressPDF() spins up a brand-new Worker("worker.js") per attempt and always
 * terminates it afterward. The orchestrator compares output size to 90% of the
 * original and escalates preset strength until the threshold is met or presets
 * are exhausted.
 */

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_THEME = "pdf-compressor-theme";

/** @typedef {"extreme" | "recommended" | "high"} CompressionLevel */

/** Strongest compression last: escalate toward smaller files. */
var LEVEL_ORDER = ["high", "recommended", "extreme"];

/** If compressed size is still above this fraction of the original, try next level. */
var SIZE_THRESHOLD_RATIO = 0.9;

// =============================================================================
// Theme
// =============================================================================

function getStoredTheme() {
  try {
    var v = localStorage.getItem(STORAGE_KEY_THEME);
    if (v === "dark" || v === "light") return v;
  } catch (_) {}
  return null;
}

function setStoredTheme(theme) {
  try { localStorage.setItem(STORAGE_KEY_THEME, theme); } catch (_) {}
}

function applyTheme(theme) {
  document.body.classList.toggle("dark-mode", theme === "dark");
}

function resolveInitialTheme() {
  var stored = getStoredTheme();
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function refreshThemeToggleUi() {
  var btn = document.getElementById("themeToggle");
  if (!btn) return;
  var dark = document.body.classList.contains("dark-mode");
  btn.setAttribute("aria-pressed", dark ? "true" : "false");
  btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
}

function initTheme() {
  applyTheme(resolveInitialTheme());
  refreshThemeToggleUi();

  document.getElementById("themeToggle").addEventListener("click", function () {
    var next = document.body.classList.contains("dark-mode") ? "light" : "dark";
    applyTheme(next);
    setStoredTheme(next);
    refreshThemeToggleUi();
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
    if (getStoredTheme() === null) {
      applyTheme(e.matches ? "dark" : "light");
      refreshThemeToggleUi();
    }
  });
}

// =============================================================================
// Utilities
// =============================================================================

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  var k = 1024;
  var units = ["B", "KB", "MB", "GB"];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  var n = bytes / Math.pow(k, i);
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + "\u00a0" + units[i];
}

function getCompressionLevel() {
  var checked = document.querySelector('input[name="compression"]:checked');
  return checked ? /** @type {CompressionLevel} */ (checked.value) : "recommended";
}

function isPdfFile(file) {
  return file && (
    file.type === "application/pdf" ||
    /\.pdf$/i.test(file.name || "")
  );
}

function levelChainFrom(start) {
  var idx = LEVEL_ORDER.indexOf(start);
  if (idx < 0) idx = LEVEL_ORDER.indexOf("recommended");
  return LEVEL_ORDER.slice(idx);
}

/**
 * Accept this pass only if output is strictly smaller than the source and meets
 * the size target (~10% reduction). If compressedSize >= originalSize, caller
 * must try the next waterfall level (no “zero compression” early exit).
 * @param {number} compressedSize
 * @param {number} originalSize
 */
function shouldAcceptCompressedResult(compressedSize, originalSize) {
  if (originalSize <= 0) return compressedSize === 0;
  if (compressedSize >= originalSize) return false;
  return compressedSize <= originalSize * SIZE_THRESHOLD_RATIO;
}

// =============================================================================
// compressPDF — exactly one compression attempt, one Worker, always terminate()
//
// @param {File} file — used only for the suggested download name
// @param {Uint8Array} pdfBytes — independent buffer; transferred to the worker
// @param {CompressionLevel} level
// @returns {Promise<{ blob: Blob, fileName: string }>}
// =============================================================================

function compressPDF(file, pdfBytes, level) {
  return new Promise(function (resolve, reject) {
    var worker = new Worker("worker.js");
    var jobId = 1;
    var finished = false;

    function terminateWorker() {
      if (finished) return;
      finished = true;
      try {
        worker.terminate();
      } catch (_) {}
    }

    worker.onmessage = function (e) {
      var d = e.data;
      if (!d || d.jobId !== jobId) return;

      if (d.type === "DONE") {
        try {
          var blob = new Blob([d.data], { type: "application/pdf" });
          var base = file.name.replace(/\.pdf$/i, "") || "document";
          resolve({
            blob: blob,
            fileName: base + "-compressed.pdf",
          });
        } finally {
          terminateWorker();
        }
      } else if (d.type === "ERROR") {
        try {
          reject(new Error(d.message || "Compression failed in worker"));
        } finally {
          terminateWorker();
        }
      }
    };

    worker.onerror = function (ev) {
      try {
        reject(new Error(ev.message || "Worker crashed"));
      } finally {
        terminateWorker();
      }
    };

    worker.postMessage(
      { type: "COMPRESS", jobId: jobId, fileData: pdfBytes, level: level },
      [pdfBytes.buffer]
    );
  });
}

/**
 * Best-result waterfall: start at user level; if output is not smaller than the
 * original, or not below the 90% size target, retry with the next stronger preset.
 * Logs each pass size (MB) for debugging.
 *
 * @param {File} file
 * @param {CompressionLevel} startLevel
 * @param {{ onAttempt?: (index: number, level: CompressionLevel) => void }} hooks
 */
async function compressBestResult(file, startLevel, hooks) {
  var buf = await file.arrayBuffer();
  var master = new Uint8Array(buf);
  var originalSize = master.byteLength;
  var chain = levelChainFrom(startLevel);
  var onAttempt = hooks && hooks.onAttempt;

  /** @type {{ blob: Blob, fileName: string, level: CompressionLevel, size: number }[]} */
  var attempts = [];

  for (var i = 0; i < chain.length; i++) {
    var lev = chain[i];
    if (onAttempt) onAttempt(i, lev);

    var copy = master.slice();
    var result = await compressPDF(file, copy, lev);

    var sizeMb = (result.blob.size / (1024 * 1024)).toFixed(2);
    console.log("Level " + lev + " resulted in " + sizeMb + " MB");

    attempts.push({
      blob: result.blob,
      fileName: result.fileName,
      level: lev,
      size: result.blob.size,
    });

    if (shouldAcceptCompressedResult(result.blob.size, originalSize)) {
      return {
        blob: result.blob,
        fileName: result.fileName,
        originalSize: originalSize,
        metThreshold: true,
        steppedDown: i > 0,
        highlyOptimizedNotice: false,
        attemptCount: i + 1,
      };
    }
  }

  var best = attempts[0];
  for (var j = 1; j < attempts.length; j++) {
    if (attempts[j].size < best.size) best = attempts[j];
  }

  var useOriginal = originalSize < best.size;
  var outBlob = useOriginal
    ? new Blob([master], { type: "application/pdf" })
    : best.blob;
  var outName = useOriginal
    ? (file.name && /\.pdf$/i.test(file.name)
        ? file.name
        : (file.name || "document").replace(/\.[^/.]+$/, "") + ".pdf")
    : best.fileName;

  return {
    blob: outBlob,
    fileName: outName,
    originalSize: originalSize,
    metThreshold: false,
    steppedDown: chain.length > 1,
    highlyOptimizedNotice: true,
    attemptCount: chain.length,
  };
}

// =============================================================================
// DOM
// =============================================================================

var els = {
  dropzone:           document.getElementById("dropzone"),
  fileInput:          document.getElementById("fileInput"),
  dropzoneEmpty:      document.getElementById("dropzoneEmpty"),
  dropzoneFile:       document.getElementById("dropzoneFile"),
  browseBtn:          document.getElementById("browseBtn"),
  changeFileBtn:      document.getElementById("changeFileBtn"),
  fileName:           document.getElementById("fileName"),
  fileSize:           document.getElementById("fileSize"),
  compressionSection: document.getElementById("compressionSection"),
  compressBtn:        document.getElementById("compressBtn"),
  processingSection:  document.getElementById("processingSection"),
  processingText:     document.getElementById("processingText"),
  processingHint:     document.getElementById("processingHint"),
  resultState:        document.getElementById("resultState"),
  compressAnotherBtn: document.getElementById("compressAnotherBtn"),
  sharePageBtn:       document.getElementById("sharePageBtn"),
  statOriginal:       document.getElementById("statOriginal"),
  statCompressed:     document.getElementById("statCompressed"),
  savedPill:          document.getElementById("savedPill"),
  resultsFootnote:    document.getElementById("resultsFootnote"),
  downloadBtn:        document.getElementById("downloadBtn"),
  shareBtn:           document.getElementById("shareBtn"),
  toast:              document.getElementById("toast"),
};

var currentFile = null;
var downloadObjectUrl = null;
var lastCompressedBlob = null;
var lastSuggestedFileName = null;

function revokeDownloadUrl() {
  if (downloadObjectUrl) {
    URL.revokeObjectURL(downloadObjectUrl);
    downloadObjectUrl = null;
  }
}

function setFile(file) {
  if (!file || !isPdfFile(file)) {
    showToast("Please choose a valid PDF file.");
    return;
  }
  currentFile = file;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);
  els.dropzoneEmpty.hidden = true;
  els.dropzoneFile.hidden  = false;
  els.dropzone.classList.add("dropzone--has-file");
  els.compressionSection.hidden = false;
  els.compressBtn.disabled      = false;
  els.resultState.hidden        = true;
  els.processingSection.hidden  = true;
  els.processingSection.classList.remove("processing--error");
  els.processingText.textContent = "Compressing your PDF\u2026";
  els.processingHint.textContent =
    "Each run uses a fresh worker and Ghostscript instance.";
  if (els.resultsFootnote) {
    els.resultsFootnote.hidden = true;
    els.resultsFootnote.textContent = "";
  }
  revokeDownloadUrl();
  lastCompressedBlob = null;
}

function clearFile() {
  currentFile = null;
  els.fileInput.value = "";
  els.fileName.textContent = "";
  els.fileSize.textContent = "";
  els.dropzoneEmpty.hidden = false;
  els.dropzoneFile.hidden  = true;
  els.dropzone.classList.remove("dropzone--has-file");
  els.compressionSection.hidden = true;
  els.compressBtn.disabled      = true;
  els.resultState.hidden        = true;
  els.processingSection.hidden  = true;
  els.processingSection.classList.remove("processing--error");
  els.processingText.textContent = "Compressing your PDF\u2026";
  els.processingHint.textContent =
    "Each run uses a fresh worker and Ghostscript instance.";
  els.statOriginal.textContent   = "";
  els.statCompressed.textContent = "";
  els.savedPill.textContent      = "";
  if (els.resultsFootnote) {
    els.resultsFootnote.hidden = true;
    els.resultsFootnote.textContent = "";
  }
  revokeDownloadUrl();
  lastCompressedBlob = null;
}

var toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("toast--visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    els.toast.classList.remove("toast--visible");
  }, 3400);
}

// =============================================================================
// Dropzone
// =============================================================================

function stopDefault(e) {
  e.preventDefault();
  e.stopPropagation();
}

["dragenter", "dragover", "dragleave", "drop"].forEach(function (ev) {
  els.dropzone.addEventListener(ev, stopDefault);
});

["dragenter", "dragover"].forEach(function (ev) {
  els.dropzone.addEventListener(ev, function () {
    els.dropzone.classList.add("dropzone--dragover");
  });
});

["dragleave", "drop"].forEach(function (ev) {
  els.dropzone.addEventListener(ev, function () {
    els.dropzone.classList.remove("dropzone--dragover");
  });
});

els.dropzone.addEventListener("drop", function (e) {
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setFile(f);
});

els.dropzone.addEventListener("click", function (e) {
  if (e.target === els.browseBtn || e.target === els.changeFileBtn) return;
  if (els.dropzone.classList.contains("dropzone--has-file")) return;
  els.fileInput.click();
});

els.dropzone.addEventListener("keydown", function (e) {
  if ((e.key === "Enter" || e.key === " ") &&
      !els.dropzone.classList.contains("dropzone--has-file")) {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.browseBtn.addEventListener("click",     function (e) { e.stopPropagation(); els.fileInput.click(); });
els.changeFileBtn.addEventListener("click", function (e) { e.stopPropagation(); els.fileInput.click(); });

els.fileInput.addEventListener("change", function () {
  var f = els.fileInput.files && els.fileInput.files[0];
  if (f) setFile(f);
});

// =============================================================================
// Compress — best-result waterfall + status copy per attempt
// =============================================================================

els.compressBtn.addEventListener("click", function () {
  if (!currentFile) return;
  var level = getCompressionLevel();

  els.compressBtn.disabled = true;
  els.processingSection.hidden = false;
  els.processingSection.classList.remove("processing--error");
  els.resultState.hidden = true;
  if (els.resultsFootnote) {
    els.resultsFootnote.hidden = true;
    els.resultsFootnote.textContent = "";
  }
  els.processingHint.textContent =
    "Each pass runs in a new worker for a clean memory state.";

  compressBestResult(currentFile, level, {
    onAttempt: function (index) {
      if (index === 0) {
        els.processingText.textContent = "Compressing your PDF\u2026";
      } else if (index === 1) {
        els.processingText.textContent = "Applying advanced optimization\u2026";
        els.processingHint.textContent =
          "Prior pass did not reach the size target; trying a stronger preset.";
      } else {
        els.processingText.textContent = "Applying maximum compression\u2026";
        els.processingHint.textContent =
          "Final pass with the strongest available settings.";
      }
    },
  })
    .then(function (out) {
      lastCompressedBlob    = out.blob;
      lastSuggestedFileName = out.fileName;

      var originalSize = out.originalSize;
      var newSize      = out.blob.size;

      els.statOriginal.textContent   = formatBytes(originalSize);
      els.statCompressed.textContent = formatBytes(newSize);

      if (out.highlyOptimizedNotice) {
        showToast("This file is already highly optimized.");
        if (newSize >= originalSize) {
          els.savedPill.textContent = "Best available — original kept";
        } else {
          var pctH = originalSize > 0
            ? Math.round((1 - newSize / originalSize) * 100)
            : 0;
          els.savedPill.textContent =
            pctH > 0 ? pctH + "% smaller (best pass)" : "Best pass selected";
        }
      } else {
        var pct = originalSize > 0
          ? Math.round((1 - newSize / originalSize) * 100)
          : 0;
        if (pct > 0) {
          els.savedPill.textContent = pct + "% smaller";
        } else {
          els.savedPill.textContent = "Reduced below 90% of original size";
        }
      }

      if (els.resultsFootnote) {
        if (!out.highlyOptimizedNotice && out.steppedDown) {
          els.resultsFootnote.textContent =
            "Stronger settings were applied automatically to hit the size target.";
          els.resultsFootnote.hidden = false;
        } else {
          els.resultsFootnote.hidden = true;
          els.resultsFootnote.textContent = "";
        }
      }

      revokeDownloadUrl();
      downloadObjectUrl = URL.createObjectURL(out.blob);

      els.processingSection.hidden = true;
      els.resultState.hidden       = false;
    })
    .catch(function (err) {
      console.error("[compress]", err);
      els.processingSection.classList.add("processing--error");
      els.processingText.textContent = "Compression failed";
      els.processingHint.textContent = (err && err.message) || "See the browser console for details.";
      showToast("Compression failed — check console for details.");
    })
    .finally(function () {
      els.compressBtn.disabled = false;
    });
});

// =============================================================================
// Download & Share
// =============================================================================

els.downloadBtn.addEventListener("click", function () {
  if (!downloadObjectUrl || !lastSuggestedFileName) return;
  var a = document.createElement("a");
  a.href     = downloadObjectUrl;
  a.download = lastSuggestedFileName;
  a.rel      = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

els.shareBtn.addEventListener("click", async function () {
  if (!lastCompressedBlob) {
    showToast("Nothing to share yet.");
    return;
  }

  var fileName    = lastSuggestedFileName || "compressed.pdf";
  var fileToShare = new File([lastCompressedBlob], fileName, { type: "application/pdf" });

  if (navigator.share) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [fileToShare] })) {
        await navigator.share({
          files: [fileToShare],
          title: "Compressed PDF",
          text:  "Compressed with PDF Compressor (100% local)",
        });
        return;
      }
      await navigator.share({
        title: "Compressed PDF",
        text:  fileName + " (" + formatBytes(lastCompressedBlob.size) + ")",
      });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.warn("[share] fallback to clipboard", err);
    }
  }

  shareClipboardFallback(fileName);
});

function shareClipboardFallback(fileName) {
  if (navigator.clipboard && window.ClipboardItem) {
    navigator.clipboard
      .write([new ClipboardItem({ "application/pdf": lastCompressedBlob })])
      .then(function () { showToast("PDF copied to clipboard."); })
      .catch(function () { copySummaryText(fileName); });
    return;
  }
  copySummaryText(fileName);
}

function copySummaryText(fileName) {
  var text = fileName + " \u2014 " + formatBytes(lastCompressedBlob.size) + " (download from app)";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { showToast("File details copied to clipboard."); },
      function () { copyTextExecCommand(text); }
    );
    return;
  }
  copyTextExecCommand(text);
}

function copyTextExecCommand(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    document.body.removeChild(ta);
    showToast(ok ? "File details copied to clipboard." : "Sharing is not available in this context.");
  } catch (e) {
    showToast("Sharing is not available in this context.");
  }
}

function initSharePage() {
  var btn = els.sharePageBtn;
  if (!btn) return;
  var shareTitleDefault = btn.getAttribute("title") || "Share";
  btn.addEventListener("click", function () {
    var url = window.location.href;
    var title = document.title;

    function showCopied() {
      btn.setAttribute("title", "Copied!");
      setTimeout(function () {
        btn.setAttribute("title", shareTitleDefault);
      }, 2000);
    }

    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function (err) {
        if (err && err.name === "AbortError") return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(showCopied).catch(function () {});
        }
      });
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(showCopied).catch(function () {
        copyUrlExecCommand(url, showCopied);
      });
    } else {
      copyUrlExecCommand(url, showCopied);
    }
  });
}

function copyUrlExecCommand(url, onOk) {
  try {
    var ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok && onOk) onOk();
  } catch (e) {
    /* ignore */
  }
}

if (els.compressAnotherBtn) {
  els.compressAnotherBtn.addEventListener("click", function () {
    clearFile();
  });
}

initTheme();
initSharePage();
