/**
 * nestmatch/src/excelExport.js
 * Builds a formatted two-sheet XLSX Blob using SheetJS.
 * Returns a Blob so it can be saved locally OR uploaded to Drive.
 */

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load SheetJS"));
    document.head.appendChild(s);
  });
}

export async function buildXlsxBlob(data) {
  await loadSheetJS();
  const XLSX = window.XLSX;
  const wb   = XLSX.utils.book_new();

  // ── Tenants sheet ──────────────────────────────────────────────────────────
  const tenantHeaders = [
    "Submission ID", "Submitted At", "Budget Min (₹)", "Budget Max (₹)",
    "Location", "Latitude", "Longitude", "Move-in Date", "Urgency",
  ];
  const tenantRows = (data.tenants || []).map((t) => [
    t.id, t.submittedAt, t.budgetMin, t.budgetMax,
    t.location, t.lat ?? "", t.lng ?? "", t.moveIn, t.urgency,
  ]);
  const wsT = XLSX.utils.aoa_to_sheet([tenantHeaders, ...tenantRows]);
  wsT["!cols"] = [12, 20, 16, 16, 38, 12, 12, 14, 26].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsT, "Tenants");

  // ── Owners sheet ──────────────────────────────────────────────────────────
  const ownerHeaders = [
    "Submission ID", "Submitted At", "Monthly Rent (₹)",
    "Location", "Latitude", "Longitude", "Available From",
  ];
  const ownerRows = (data.owners || []).map((o) => [
    o.id, o.submittedAt, o.rent,
    o.location, o.lat ?? "", o.lng ?? "", o.availFrom,
  ]);
  const wsO = XLSX.utils.aoa_to_sheet([ownerHeaders, ...ownerRows]);
  wsO["!cols"] = [12, 20, 20, 38, 12, 12, 16].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsO, "Owners");

  // Return as Blob
  const wbArr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([wbArr], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function downloadBlob(blob, filename = "nestmatch_data.xlsx") {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href    = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
