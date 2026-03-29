/**
 * Ghostscript WASM — on-demand worker (fresh Module per message)
 *
 * Stable path: AutoFilter on for color/gray (transparent PNGs), downsample + QFactor
 * via settings.ps; metadata stripped with Printed/PreserveInfo.
 */

self.onmessage = function (e) {
  var d = e.data;
  if (!d || d.type !== "COMPRESS") return;

  var jobId = typeof d.jobId === "number" ? d.jobId : 1;
  var fileData = d.fileData;
  var level = d.level;

  if (!(fileData instanceof Uint8Array) || fileData.length === 0) {
    self.postMessage({
      type: "ERROR",
      jobId: jobId,
      message: "Invalid or empty fileData.",
    });
    return;
  }

  function buildArguments() {
    var base = [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dPDFSETTINGS=/screen",
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-sColorConversionStrategy=sRGB",
      "-dConvertCMYKImagesToRGB=true",
      "-dPrinted=false",
      "-dPreserveInfo=false",
      "-sOutputFile=output.pdf",
    ];

    var s = String(level || "").trim().toLowerCase().replace(/\s+/g, "");

    if (s === "extreme" || s === "extremecompression") {
      base.push(
        "-dColorImageResolution=72",
        "-dGrayImageResolution=72",
        "-dMonoImageResolution=72",
        "-dDownsampleColorImages=true",
        "-dDownsampleGrayImages=true",
        "-dAutoFilterColorImages=true",
        "-dAutoFilterGrayImages=true"
      );
    } else if (s === "high" || s === "highquality") {
      base[2] = "-dPDFSETTINGS=/printer";
      base.push(
        "-dColorImageResolution=300",
        "-dGrayImageResolution=300",
        "-dMonoImageResolution=300",
        "-dDownsampleColorImages=true"
      );
    } else {
      base[2] = "-dPDFSETTINGS=/ebook";
      base.push(
        "-dColorImageResolution=150",
        "-dGrayImageResolution=150",
        "-dMonoImageResolution=150",
        "-dDownsampleColorImages=true"
      );
    }

    if (s !== "high" && s !== "highquality") {
      base.push("settings.ps");
    }

    base.push("input.pdf");
    return base;
  }

  var settled = false;
  function safeUnlink(name) {
    try {
      if (typeof Module !== "undefined" && Module.FS) {
        Module.FS.unlink(name);
      }
    } catch (_) {}
  }
  function cleanupVfs() {
    safeUnlink("input.pdf");
    safeUnlink("output.pdf");
    safeUnlink("settings.ps");
  }
  function settleError(msg) {
    if (settled) return;
    settled = true;
    cleanupVfs();
    self.postMessage({
      type: "ERROR",
      jobId: jobId,
      message: String(msg || "Ghostscript error"),
    });
  }
  function settleDone(outCopy) {
    if (settled) return;
    settled = true;
    cleanupVfs();
    self.postMessage(
      { type: "DONE", jobId: jobId, data: outCopy },
      [outCopy.buffer]
    );
  }

  var Module = {
    locateFile: function (path) {
      if (path.endsWith(".wasm")) return "gs-worker.wasm";
      return path;
    },

    arguments: buildArguments(),

    preRun: [
      function () {
        Module.FS.writeFile("input.pdf", fileData, { encoding: "binary" });

        var s = String(level || "").trim().toLowerCase().replace(/\s+/g, "");
        if (s === "extreme" || s === "extremecompression") {
          var ps =
            "<< /ColorImageDict << /QFactor 0.20 /ColorTransform 1 >> /GrayImageDict << /QFactor 0.20 >> >> setdistillerparams";
          Module.FS.writeFile("settings.ps", ps);
        } else if (s !== "high" && s !== "highquality") {
          var ps =
            "<< /ColorImageDict << /QFactor 0.65 /ColorTransform 1 >> /GrayImageDict << /QFactor 0.65 >> >> setdistillerparams";
          Module.FS.writeFile("settings.ps", ps);
        }
      },
    ],

    postRun: [
      function () {
        if (settled) return;
        try {
          var raw = Module.FS.readFile("output.pdf", { encoding: "binary" });
          var outCopy = new Uint8Array(raw.length);
          outCopy.set(raw);
          settleDone(outCopy);
        } catch (err) {
          settleError(
            err && err.message
              ? err.message
              : "Failed to read output.pdf (Ghostscript may have failed)."
          );
        }
      },
    ],

    print: function () {
      console.log.apply(console, arguments);
    },

    printErr: function () {
      console.error.apply(console, arguments);
    },

    quit: function (status, toThrow) {
      if (status !== 0) {
        var msg =
          toThrow && (toThrow.message || String(toThrow))
            ? toThrow.message || String(toThrow)
            : "Ghostscript exited with status " + status;
        settleError(msg);
      }
    },
  };

  self.Module = Module;

  try {
    importScripts("gs-worker.js");
  } catch (err) {
    settleError(
      "Failed to load gs-worker.js: " +
        (err && err.message ? err.message : String(err))
    );
  }
};
