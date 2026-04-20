/**
 * NestMatch — Google Apps Script Web App
 * Sheets: Tenant | Owner | Users | Reservations | SavedSearches
 *
 * Reservations sheet tracks:
 *   Status = "Reserved" → property is currently reserved
 *   Status = "Visit Done" → visit completed, property available again
 * Visit Count = cumulative visits per submission ID
 */

const COLS = {
  Users:  ["Registered At","First Name","Last Name","Mobile","Password Hash"],
  Tenant: ["Submission ID","Submitted At","User Name","Mobile","Budget Min (₹)","Budget Max (₹)","BHK Types","Location","Latitude","Longitude","Move-in Date","Urgency"],
  Owner:  ["Submission ID","Submitted At","User Name","Mobile","Monthly Rent (₹)","BHK Types","Location","Latitude","Longitude","Available From"],
  Reservations: ["Reservation ID","Reserved At","Tenant Name","Tenant Mobile","Owner Name","Owner Mobile","Submission ID","Property Location","Monthly Rent (₹)","Amount Paid (₹)","Status","Visit Count"],
  SavedSearches: ["User Mobile","User Name","Budget Min (₹)","Budget Max (₹)","BHK Types","Location","Move-in Date","Urgency","Saved At"]
};

const HEADER_BG = {
  Users:"#E6F1FB", Tenant:"#F5E8DF", Owner:"#EDFAF3",
  Reservations:"#FEF8E7", SavedSearches:"#F5F2EE"
};

// ── GET ───────────────────────────────────────────────────────────────────────
function doGet(e) {
  const p = e.parameter || {};

  // Dedicated login endpoint — avoids CORS cold-start issues on mobile/WhatsApp
  if (p.action === "login") {
    const mobile = String(p.mobile || "").replace(/\D/g, "");
    const hash   = p.hash || "";
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
      if (!sheet || sheet.getLastRow() < 2)
        return jsonResponse({ success: false, error: "No users registered yet" });
      const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
      if (hash === "__check_duplicate__") {
        return jsonResponse({ exists: values.some(r => String(r[3]).replace(/\D/g,"") === mobile) });
      }
      const user = values.find(r =>
        String(r[3]).replace(/\D/g,"") === mobile && String(r[4]) === hash
      );
      if (!user) return jsonResponse({ success: false, error: "Mobile number or password is incorrect" });
      return jsonResponse({ success: true, user: {
        firstName: user[1], lastName: user[2],
        mobile: String(user[3]).replace(/\D/g,"")
      }});
    } catch (err) { return jsonResponse({ success: false, error: err.message }); }
  }

  // Sheet data read
  const sheetName = p.sheet || "";
  const cols = COLS[sheetName];
  if (!cols) return jsonResponse({ error: "Unknown sheet: " + sheetName });
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return jsonResponse({ data: [] });
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols.length).getValues();
    const data = values.map(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
    return jsonResponse({ data });
  } catch (err) { return jsonResponse({ error: err.message }); }
}

// ── POST ──────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const payload   = JSON.parse(e.postData.contents);
    const sheetName = payload.sheet;
    const cols      = COLS[sheetName];
    if (!cols) return jsonResponse({ success: false, error: "Unknown sheet: " + sheetName });

    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    let   sheet = ss.getSheetByName(sheetName);

    // Auto-create sheet with styled header if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      const hdr = sheet.getRange(1, 1, 1, cols.length);
      hdr.setValues([cols]);
      hdr.setFontWeight("bold");
      hdr.setBackground(HEADER_BG[sheetName] || "#F0F0F0");
      sheet.setFrozenRows(1);
    }

    const mobileIdx = cols.indexOf("Mobile");
    const row = cols.map((col, i) => {
      const val = payload[col];
      if (val === undefined || val === null) return "";
      // Store mobile as digits-only to prevent Sheets parsing errors
      if (i === mobileIdx) return String(val).replace(/\D/g, "");
      return val;
    });

    sheet.appendRow(row);

    // Force mobile column as plain text (no yellow warning triangle)
    if (mobileIdx >= 0) {
      const lastRow = sheet.getLastRow();
      sheet.getRange(lastRow, mobileIdx + 1)
           .setNumberFormat("@")
           .setValue(String(row[mobileIdx]));
    }

    // ── Reservations special handling ──────────────────────────────────────
    if (sheetName === "Reservations") {
      const lastRow = sheet.getLastRow();
      const status  = String(payload["Status"] || "");
      const subId   = String(payload["Submission ID"] || "");

      if (status === "Reserved") {
        // Highlight row amber + add note to Owner row
        sheet.getRange(lastRow, 1, 1, cols.length).setBackground("#FEF8E7");
        _markOwnerRow(ss, subId, "#FEF8E7", "RESERVED by " + payload["Tenant Name"] + " on " + payload["Reserved At"]);
      } else if (status === "Visit Done") {
        // Highlight row green + update Owner row
        sheet.getRange(lastRow, 1, 1, cols.length).setBackground("#EDFAF3");
        _markOwnerRow(ss, subId, "#EDFAF3", "Visit completed. Total visits: " + (payload["Visit Count"] || 1));
      }
    }

    sheet.autoResizeColumns(1, cols.length);
    return jsonResponse({ success: true, sheet: sheetName, totalRows: sheet.getLastRow() - 1 });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── Helper: mark the owner row for a given submission ID ────────────────────
function _markOwnerRow(ss, subId, bgColor, noteText) {
  const ownerSheet = ss.getSheetByName("Owner");
  if (!ownerSheet || ownerSheet.getLastRow() < 2) return;
  const oCols  = COLS.Owner;
  const subIdx = oCols.indexOf("Submission ID");
  const oVals  = ownerSheet.getRange(2, 1, ownerSheet.getLastRow() - 1, oCols.length).getValues();
  oVals.forEach((oRow, idx) => {
    if (String(oRow[subIdx]) === subId) {
      ownerSheet.getRange(idx + 2, 1, 1, oCols.length).setBackground(bgColor);
      ownerSheet.getRange(idx + 2, 1).setNote(noteText);
    }
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
