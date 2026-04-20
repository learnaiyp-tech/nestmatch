import { useState, useEffect, useRef, useCallback } from "react";
import { addTenant, addOwner } from "./storage";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SHEET_URL   = "https://script.google.com/macros/s/AKfycbxHd0Hoh8feNBiEM0MtrU--ZmMifU664VlAEMRt214QcYmSi391MoIEYD1p6haTK1U/exec";
const UPI_ID      = "your-upi@upi";  // ← replace with your UPI ID
const UPI_NAME    = "NestMatch";
const UPI_AMOUNT  = "0.01";
const BHK_OPTIONS = ["1BHK", "2BHK", "3BHK", "Townhouse"];

// ─────────────────────────────────────────────────────────────────────────────
// SHEET API  — POST uses no-cors (write); GET uses cors (read + login)
// Login uses POST to Apps Script action=login to avoid cold-start CORS issues
// ─────────────────────────────────────────────────────────────────────────────
async function postToSheet(sheet, payload) {
  await fetch(SHEET_URL, {
    method: "POST", mode: "no-cors",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ sheet, ...payload }),
  });
}

async function fetchSheet(sheet) {
  const res = await fetch(`${SHEET_URL}?sheet=${sheet}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return (await res.json()).data || [];
}

// Login via GET with retry (3 attempts, exponential backoff for cold starts)
async function loginRequest(mobile, hash) {
  const url = `${SHEET_URL}?action=login&mobile=${encodeURIComponent(mobile)}&hash=${encodeURIComponent(hash)}`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return res.json();
      lastErr = new Error(`Status ${res.status}`);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 1200 * (i + 1))); // 1.2s, 2.4s, 3.6s
  }
  throw lastErr;
}

// Signup check also retries
async function checkDuplicate(mobile) {
  const url = `${SHEET_URL}?action=login&mobile=${encodeURIComponent(mobile)}&hash=__check_duplicate__`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return res.json();
      lastErr = new Error(`Status ${res.status}`);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD HASH (SHA-256)
// ─────────────────────────────────────────────────────────────────────────────
async function hashPassword(plain) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL STORAGE — all keys per-user-mobile so data is isolated per account
// ─────────────────────────────────────────────────────────────────────────────
const SESS_KEY         = "nm_session";
const ROLE_KEY         = "nm_role";

function getSession()       { try { return JSON.parse(localStorage.getItem(SESS_KEY)); }    catch { return null; } }
function setSession(u)      { localStorage.setItem(SESS_KEY, JSON.stringify(u)); }
function clearSession()     { localStorage.removeItem(SESS_KEY); }

function getRole()          { return localStorage.getItem(ROLE_KEY) || "tenant"; }
function setRole(r)         { localStorage.setItem(ROLE_KEY, r); }

// Saved searches — keyed per user mobile → survives relogin, cross-session
function searchesKey(m)     { return `nm_searches_${m}`; }
function getSavedSearches(m){ try { return JSON.parse(localStorage.getItem(searchesKey(m))) || []; } catch { return []; } }
function saveSearchLocal(m, s) {
  const list = getSavedSearches(m);
  // Avoid exact duplicates
  const isDup = list.some(x =>
    x.budgetMin === s.budgetMin && x.budgetMax === s.budgetMax &&
    x.location?.address === s.location?.address && x.moveIn === s.moveIn
  );
  if (!isDup) {
    list.unshift({ ...s, savedAt: new Date().toLocaleString("en-IN") });
    localStorage.setItem(searchesKey(m), JSON.stringify(list.slice(0, 10)));
  }
}
function deleteSavedSearch(m, i) {
  const list = getSavedSearches(m); list.splice(i, 1);
  localStorage.setItem(searchesKey(m), JSON.stringify(list));
}

// Listing — per owner mobile
function listingKey(m)      { return `nm_listing_${m}`; }
function getOwnerListing(m) { try { return JSON.parse(localStorage.getItem(listingKey(m))); } catch { return null; } }
function setOwnerListing(m, l){ localStorage.setItem(listingKey(m), JSON.stringify(l)); }

// Reservations — { [submissionId]: { reservedBy, reservedAt, tenantName, tenantMobile, visitCount } }
// Stored globally (all users share reservation state so everyone sees correct status)
const RES_KEY = "nm_reservations";
function getReservations()  { try { return JSON.parse(localStorage.getItem(RES_KEY)) || {}; } catch { return {}; } }
function getReservation(id) { return getReservations()[id] || null; }
function setReservation(id, data) {
  const r = getReservations(); r[id] = data;
  localStorage.setItem(RES_KEY, JSON.stringify(r));
}
function clearReservation(id) {
  const r = getReservations(); delete r[id];
  localStorage.setItem(RES_KEY, JSON.stringify(r));
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCHING LOGIC — BHK overlap + budget + date
// ─────────────────────────────────────────────────────────────────────────────
function bhkOverlap(tenantBhk, ownerBhk) {
  // tenantBhk and ownerBhk are comma-separated strings stored in sheet
  const tSet = new Set(String(tenantBhk || "").split(",").map(s => s.trim()).filter(Boolean));
  const oSet = new Set(String(ownerBhk  || "").split(",").map(s => s.trim()).filter(Boolean));
  if (!tSet.size || !oSet.size) return false;
  return [...tSet].some(b => oSet.has(b));
}

function scoreMatch(budgetMin, budgetMax, moveInDate, ownerRent, ownerAvail, tenantBhk, ownerBhk) {
  const tMin = Number(budgetMin), tMax = Number(budgetMax), oRent = Number(ownerRent);
  if (!tMin || !tMax || !oRent) return null;
  if (oRent < tMin || oRent > tMax) return null;
  if (!bhkOverlap(tenantBhk, ownerBhk)) return null;
  const moveIn = moveInDate ? new Date(moveInDate) : null;
  const avail  = ownerAvail  ? new Date(ownerAvail)  : null;
  if (moveIn && avail && avail > moveIn) return null;
  const gap = Math.abs(oRent - (tMin + tMax) / 2) / ((tMax - tMin) / 2 || 1);
  return gap < 0.2 ? "high" : gap < 0.6 ? "medium" : "low";
}

function buildTenantMatches(entry, owners) {
  const result = { high_priority: [], medium: [], low: [] };
  owners.forEach(o => {
    const p = scoreMatch(
      entry["Budget Min (₹)"], entry["Budget Max (₹)"], entry["Move-in Date"],
      o["Monthly Rent (₹)"], o["Available From"],
      entry["BHK Types"], o["BHK Types"]
    );
    if (!p) return;
    result[p === "high" ? "high_priority" : p].push({
      id: o["Submission ID"] || String(Math.random()),
      rent: Number(o["Monthly Rent (₹)"]), location: o["Location"] || "—",
      available: o["Available From"] || "—", bhk: o["BHK Types"] || "—",
      ownerName: o["User Name"] || "—", ownerMobile: String(o["Mobile"] || "").replace(/\D/g,""),
    });
  });
  return result;
}

function buildOwnerMatches(entry, tenants) {
  const result = { high_priority: [], medium: [], low: [] };
  tenants.forEach(t => {
    const p = scoreMatch(
      t["Budget Min (₹)"], t["Budget Max (₹)"], t["Move-in Date"],
      entry["Monthly Rent (₹)"], entry["Available From"],
      t["BHK Types"], entry["BHK Types"]
    );
    if (!p) return;
    result[p === "high" ? "high_priority" : p].push({
      id: t["Submission ID"] || String(Math.random()),
      budgetMin: Number(t["Budget Min (₹)"]), budgetMax: Number(t["Budget Max (₹)"]),
      location: t["Location"] || "—", moveIn: t["Move-in Date"] || "—",
      urgency: t["Urgency"] || "—", bhk: t["BHK Types"] || "—",
      tenantName: t["User Name"] || "—", tenantMobile: String(t["Mobile"] || "").replace(/\D/g,""),
    });
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getToday()    { return new Date().toISOString().split("T")[0]; }
function getTomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; }

// ─────────────────────────────────────────────────────────────────────────────
// LEAFLET + NOMINATIM
// ─────────────────────────────────────────────────────────────────────────────
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (window.__ll) return window.__ll;
  window.__ll = new Promise((res, rej) => {
    const l = document.createElement("link"); l.rel = "stylesheet";
    l.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"; document.head.appendChild(l);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return window.__ll;
}
async function nominatimSearch(q) {
  if (!q || q.length < 3) return [];
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=in&limit=6&addressdetails=1`, { headers: { "Accept-Language": "en", "User-Agent": "NestMatch/1.0" } });
  return r.ok ? r.json() : [];
}
async function nominatimReverse(lat, lng) {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, { headers: { "Accept-Language": "en", "User-Agent": "NestMatch/1.0" } });
  return r.ok ? r.json() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Sans',sans-serif;}
  .app{min-height:100vh;background:#FAF7F2;color:#1C1C1A;}

  /* NAV */
  .nav{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.75rem;background:#FAF7F2;border-bottom:1px solid #E8E0D4;position:sticky;top:0;z-index:200;}
  .nav-logo{font-family:'DM Serif Display',serif;font-size:1.5rem;color:#C05A2A;cursor:pointer;}
  .nav-logo span{color:#1C1C1A;}
  .nav-right{display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;}
  .nav-btn{font-size:0.75rem;font-weight:500;cursor:pointer;letter-spacing:0.05em;padding:0.38rem 0.85rem;border-radius:20px;transition:all 0.2s;border:1px solid;white-space:nowrap;font-family:'DM Sans',sans-serif;background:none;}
  .nav-btn.back{color:#8A7A6A;border-color:#D4C8B8;} .nav-btn.back:hover{background:#F0E8DC;color:#1C1C1A;}
  .role-switch{display:flex;align-items:center;background:#F0E8DC;border-radius:20px;padding:3px;gap:2px;}
  .role-tab{font-size:0.72rem;font-weight:500;padding:0.3rem 0.8rem;border-radius:16px;cursor:pointer;transition:all 0.2s;border:none;font-family:'DM Sans',sans-serif;color:#8A7A6A;background:transparent;}
  .role-tab.active{background:#C05A2A;color:#FAF7F2;}
  .role-tab:not(.active):hover{background:#E8D8CC;color:#1C1C1A;}

  /* PROFILE */
  .profile-btn{display:flex;align-items:center;gap:0.45rem;cursor:pointer;padding:0.3rem 0.7rem 0.3rem 0.3rem;border-radius:20px;border:1px solid #E0D6C8;background:#fff;transition:all 0.2s;font-family:'DM Sans',sans-serif;}
  .profile-btn:hover{background:#F5E8DF;border-color:#C05A2A;}
  .avatar{width:30px;height:30px;border-radius:50%;background:#C05A2A;color:#FAF7F2;display:flex;align-items:center;justify-content:center;font-size:0.78rem;font-weight:600;flex-shrink:0;}
  .profile-name{font-size:0.78rem;font-weight:500;color:#1C1C1A;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .profile-dropdown{position:absolute;top:calc(100% + 8px);right:0;background:#fff;border:1.5px solid #E0D6C8;border-radius:10px;min-width:190px;z-index:9999;overflow:hidden;box-shadow:0 4px 20px rgba(28,28,26,0.1);}
  .profile-dropdown-header{padding:0.75rem 1rem;border-bottom:1px solid #F0E8DC;}
  .profile-dropdown-name{font-size:0.85rem;font-weight:600;color:#1C1C1A;}
  .profile-dropdown-mobile{font-size:0.75rem;color:#8A7A6A;margin-top:2px;}
  .dropdown-item{width:100%;padding:0.6rem 1rem;background:none;border:none;text-align:left;font-size:0.82rem;font-family:'DM Sans',sans-serif;cursor:pointer;display:flex;align-items:center;gap:0.5rem;border-top:1px solid #F0E8DC;}
  .dropdown-item.listings{color:#185FA5;} .dropdown-item.listings:hover{background:#E6F1FB;}
  .dropdown-item.logout{color:#9A2828;}   .dropdown-item.logout:hover{background:#FCF0F0;}

  /* TOAST */
  .toast{position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;padding:0.75rem 1.1rem;border-radius:8px;font-size:0.82rem;font-weight:500;max-width:320px;line-height:1.5;animation:slideUp 0.3s ease;}
  .toast.success{background:#EDFAF3;color:#1B7A45;border:1px solid #C0E8D0;}
  .toast.error{background:#FCF0F0;color:#9A2828;border:1px solid #F5BFBF;}
  .toast.info{background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;}
  @keyframes slideUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}

  /* ── ANIMATED HOME PAGE ── */
  .home-page{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100vh - 62px);padding:2rem 1.5rem;text-align:center;background:linear-gradient(175deg,#FAF7F2 50%,#F5E8DF 100%);}
  .home-scene{width:260px;height:200px;position:relative;margin-bottom:2rem;}

  /* Ground */
  .ground{position:absolute;bottom:0;left:0;right:0;height:28px;background:#C8E6C9;border-radius:14px;}
  .grass-blade{position:absolute;bottom:26px;width:4px;height:10px;background:#81C784;border-radius:2px 2px 0 0;animation:sway 2.5s ease-in-out infinite;}
  @keyframes sway{0%,100%{transform:rotate(-5deg);}50%{transform:rotate(5deg);}}

  /* House body */
  .house-body{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);width:130px;height:90px;background:#FFFFFF;border-radius:4px 4px 0 0;border:2px solid #E8E0D4;}
  /* Roof */
  .roof{position:absolute;bottom:116px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:80px solid transparent;border-right:80px solid transparent;border-bottom:55px solid #C05A2A;}
  .roof-edge{position:absolute;bottom:113px;left:50%;transform:translateX(-50%);width:160px;height:8px;background:#A34A20;border-radius:2px;}
  /* Chimney */
  .chimney{position:absolute;bottom:155px;left:calc(50% + 28px);width:22px;height:36px;background:#8B4A30;border-radius:3px 3px 0 0;}
  /* Smoke puffs */
  .smoke{position:absolute;border-radius:50%;background:rgba(180,180,180,0.55);animation:float 2.8s ease-in-out infinite;}
  .smoke1{width:14px;height:14px;bottom:195px;left:calc(50% + 30px);animation-delay:0s;}
  .smoke2{width:10px;height:10px;bottom:210px;left:calc(50% + 24px);animation-delay:0.9s;}
  .smoke3{width:8px;height:8px;bottom:222px;left:calc(50% + 32px);animation-delay:1.8s;}
  @keyframes float{0%{opacity:0;transform:translateY(0) scale(0.5);}40%{opacity:0.7;}100%{opacity:0;transform:translateY(-28px) scale(1.3);}}

  /* Door */
  .door{position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:32px;height:50px;background:#C05A2A;border-radius:16px 16px 0 0;}
  .door-knob{position:absolute;right:7px;top:50%;transform:translateY(-50%);width:5px;height:5px;background:#FAF7F2;border-radius:50%;}
  .door-line{position:absolute;top:0;left:50%;transform:translateX(-50%);width:1.5px;height:100%;background:rgba(0,0,0,0.12);}

  /* Windows */
  .window{position:absolute;width:26px;height:26px;background:#B3D9FF;border:2px solid #E8E0D4;border-radius:4px;}
  .window::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent,transparent 10px,rgba(255,255,255,0.5) 10px,rgba(255,255,255,0.5) 11px),repeating-linear-gradient(0deg,transparent,transparent 10px,rgba(255,255,255,0.5) 10px,rgba(255,255,255,0.5) 11px);}
  .window.left{bottom:35px;left:18px;}
  .window.right{bottom:35px;right:18px;}
  .window-glow{animation:glow 3s ease-in-out infinite;}
  @keyframes glow{0%,100%{background:#B3D9FF;}50%{background:#FFE082;}}

  /* Path */
  .path{position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:24px;height:30px;background:#D4C8B8;border-radius:0 0 8px 8px;}

  /* Stars */
  .star{position:absolute;width:5px;height:5px;background:#F5C842;border-radius:50%;animation:twinkle 2s ease-in-out infinite;}
  @keyframes twinkle{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.2;transform:scale(0.5);}}

  /* Bounce for whole house */
  .house-wrap{animation:houseBounce 4s ease-in-out infinite;}
  @keyframes houseBounce{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}

  /* Text */
  .home-greeting{font-family:'DM Serif Display',serif;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.2;color:#1C1C1A;max-width:520px;margin-bottom:0.85rem;}
  .home-greeting em{font-style:italic;color:#C05A2A;}
  .home-sub-text{font-size:0.95rem;color:#6E6257;max-width:400px;line-height:1.75;margin-bottom:2.5rem;}
  .home-role-prompt{font-size:0.8rem;color:#8A7A6A;margin-bottom:0.6rem;font-weight:500;}
  .home-cta-row{display:flex;gap:0.8rem;flex-wrap:wrap;justify-content:center;}

  /* LANDING */
  .landing{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100vh - 62px);padding:4rem 1.5rem;text-align:center;}
  .landing-eyebrow{font-size:0.7rem;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#C05A2A;margin-bottom:1.1rem;}
  .landing-title{font-family:'DM Serif Display',serif;font-size:clamp(2.6rem,7vw,5rem);line-height:1.05;color:#1C1C1A;max-width:720px;margin-bottom:1.1rem;}
  .landing-title em{font-style:italic;color:#C05A2A;}
  .landing-sub{font-size:1rem;color:#6E6257;max-width:440px;line-height:1.75;margin-bottom:3rem;}
  .landing-btns{display:flex;gap:1rem;flex-wrap:wrap;justify-content:center;}
  .btn-hero{padding:0.9rem 2.4rem;border-radius:4px;font-family:'DM Sans',sans-serif;font-size:0.95rem;font-weight:500;cursor:pointer;transition:all 0.2s;}
  .btn-hero.solid{background:#C05A2A;color:#FAF7F2;border:none;} .btn-hero.solid:hover{background:#A34A20;transform:translateY(-2px);}
  .btn-hero.ghost{background:transparent;color:#1C1C1A;border:1.5px solid #C4B8A8;} .btn-hero.ghost:hover{border-color:#C05A2A;background:#F5E8DF;transform:translateY(-2px);}
  .landing-badges{display:flex;gap:1.5rem;margin-top:3.5rem;flex-wrap:wrap;justify-content:center;}
  .landing-badge{font-size:0.75rem;color:#8A7A6A;display:flex;align-items:center;gap:0.4rem;}
  .landing-badge::before{content:'✓';color:#C05A2A;font-weight:700;}

  /* AUTH */
  .auth-page{min-height:calc(100vh - 62px);display:flex;align-items:center;justify-content:center;padding:2rem 1.25rem;}
  .auth-card{background:#fff;border:1px solid #E8E0D4;border-radius:14px;padding:2.5rem 2.25rem;width:100%;max-width:440px;}
  .auth-logo{font-family:'DM Serif Display',serif;font-size:1.3rem;color:#C05A2A;}
  .auth-logo span{color:#1C1C1A;}
  .auth-title{font-family:'DM Serif Display',serif;font-size:1.75rem;color:#1C1C1A;margin-bottom:0.3rem;margin-top:1.2rem;}
  .auth-sub{font-size:0.85rem;color:#8A7A6A;margin-bottom:1.75rem;line-height:1.55;}
  .auth-sub a{color:#C05A2A;cursor:pointer;font-weight:500;} .auth-sub a:hover{text-decoration:underline;}
  .auth-connecting{font-size:0.78rem;color:#8A7A6A;text-align:center;padding:0.5rem;animation:pulse 1.5s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}
  .phone-row{display:flex;border:1.5px solid #E0D6C8;border-radius:6px;overflow:hidden;transition:border-color 0.2s,box-shadow 0.2s;background:#FDFCFA;}
  .phone-row:focus-within{border-color:#C05A2A;box-shadow:0 0 0 3px rgba(192,90,42,0.1);background:#fff;}
  .phone-row.error{border-color:#E24B4A;}
  .phone-prefix{padding:0.7rem 0.75rem;background:#F5E8DF;color:#7A3A15;font-size:0.9rem;font-weight:500;border-right:1px solid #E0D6C8;white-space:nowrap;}
  .phone-input{flex:1;padding:0.7rem 0.75rem;border:none;background:transparent;font-family:'DM Sans',sans-serif;font-size:0.9rem;color:#1C1C1A;outline:none;}
  .pw-strength{margin-top:0.35rem;height:3px;border-radius:2px;background:#E0D6C8;overflow:hidden;}
  .pw-strength-fill{height:100%;border-radius:2px;transition:width 0.3s,background 0.3s;}
  .pw-hint{font-size:0.7rem;margin-top:0.3rem;}
  .pw-wrap{position:relative;} .pw-wrap .form-input{padding-right:3rem;}
  .pw-toggle{position:absolute;right:0.75rem;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#BDB4A8;font-size:0.78rem;padding:0;} .pw-toggle:hover{color:#6E6257;}

  /* FORM */
  .form-page{max-width:820px;margin:0 auto;padding:2.5rem 1.5rem 5rem;}
  .form-tag{display:inline-block;font-size:0.65rem;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#C05A2A;background:#F5E8DF;padding:0.3rem 0.7rem;border-radius:3px;margin-bottom:0.8rem;}
  .form-title{font-family:'DM Serif Display',serif;font-size:2.1rem;line-height:1.15;color:#1C1C1A;margin-bottom:0.5rem;}
  .form-desc{font-size:0.9rem;color:#8A7A6A;line-height:1.6;}
  .form-card{background:#FFFFFF;border:1px solid #E8E0D4;border-radius:10px;padding:2rem;margin-top:2rem;}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;}
  @media(max-width:500px){.form-row{grid-template-columns:1fr;}.auth-card{padding:2rem 1.25rem;}}
  .form-group{display:flex;flex-direction:column;gap:0.4rem;margin-bottom:1.25rem;}
  .form-label{font-size:0.78rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6E6257;}
  .required{color:#C05A2A;margin-left:2px;}
  .form-input,.form-select{padding:0.7rem 0.9rem;border:1.5px solid #E0D6C8;border-radius:6px;font-family:'DM Sans',sans-serif;font-size:0.9rem;color:#1C1C1A;background:#FDFCFA;transition:border-color 0.2s,box-shadow 0.2s;appearance:none;width:100%;}
  .form-input:focus,.form-select:focus{outline:none;border-color:#C05A2A;box-shadow:0 0 0 3px rgba(192,90,42,0.1);background:#fff;}
  .form-input.error{border-color:#E24B4A;}
  .form-error{font-size:0.75rem;color:#E24B4A;margin-top:2px;}
  .form-input::placeholder{color:#BDB4A8;}
  .divider{height:1px;background:#F0E8DC;margin:1.5rem 0;}
  .submit-row{margin-top:1.5rem;}
  .btn-submit{width:100%;background:#C05A2A;color:#FAF7F2;border:none;padding:0.85rem 1.5rem;border-radius:6px;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:500;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:0.5rem;}
  .btn-submit:hover:not(:disabled){background:#A34A20;}
  .btn-submit:disabled{opacity:0.7;cursor:not-allowed;}
  .spinner{width:16px;height:16px;border:2px solid rgba(250,247,242,0.4);border-top-color:#FAF7F2;border-radius:50%;animation:spin 0.7s linear infinite;}
  .spinner-dark{width:16px;height:16px;border:2px solid #E0D6C8;border-top-color:#C05A2A;border-radius:50%;animation:spin 0.7s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg);}}

  /* BHK CHECKBOXES */
  .bhk-group{display:flex;flex-wrap:wrap;gap:0.5rem;}
  .bhk-chip{display:flex;align-items:center;gap:0.35rem;padding:0.38rem 0.75rem;border:1.5px solid #E0D6C8;border-radius:20px;cursor:pointer;font-size:0.8rem;font-weight:500;color:#6E6257;background:#FDFCFA;transition:all 0.18s;user-select:none;}
  .bhk-chip:hover{border-color:#C05A2A;background:#FFF8F4;color:#C05A2A;}
  .bhk-chip.selected{border-color:#C05A2A;background:#F5E8DF;color:#7A3A15;}
  .bhk-chip input{display:none;}
  .bhk-check{width:14px;height:14px;border-radius:3px;border:1.5px solid #C4B8A8;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .bhk-chip.selected .bhk-check{background:#C05A2A;border-color:#C05A2A;color:#fff;font-size:9px;}

  /* SAVED SEARCHES */
  .saved-section{margin-top:1.75rem;border-top:1px solid #F0E8DC;padding-top:1.5rem;}
  .saved-title{font-size:0.78rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6E6257;margin-bottom:0.85rem;display:flex;align-items:center;gap:0.5rem;}
  .saved-item{display:flex;align-items:center;gap:0.65rem;padding:0.65rem 0.85rem;background:#FAF7F2;border:1px solid #E8E0D4;border-radius:8px;margin-bottom:0.5rem;cursor:pointer;transition:border-color 0.15s;}
  .saved-item:hover{border-color:#C05A2A;background:#FFF8F4;}
  .saved-info{flex:1;}
  .saved-budget{font-size:0.85rem;font-weight:500;color:#1C1C1A;}
  .saved-meta{font-size:0.72rem;color:#8A7A6A;margin-top:1px;}
  .saved-del{background:none;border:none;color:#BDB4A8;cursor:pointer;font-size:0.9rem;padding:0.2rem;} .saved-del:hover{color:#E24B4A;}

  /* OSM — Location field with map displayed to the right on desktop */
  .osm-field{position:relative;}
  .osm-layout{display:grid;grid-template-columns:1fr 1fr;gap:1rem;align-items:start;}
  @media(max-width:600px){.osm-layout{grid-template-columns:1fr;}}
  .osm-left{display:flex;flex-direction:column;gap:0.5rem;position:relative;}
  .osm-right{border-radius:8px;overflow:hidden;border:1.5px solid #E0D6C8;background:#F5F2EE;}
  .osm-right .osm-map{width:100%;height:218px;}
  .osm-right .osm-map-loading{height:218px;}
  .osm-map-hint-text{font-size:0.67rem;color:#8A7A6A;padding:0.3rem 0.6rem;background:#FAF7F2;border-top:1px solid #E8E0D4;display:flex;align-items:center;gap:0.3rem;}
  .osm-search-row{display:flex;gap:0.5rem;}
  .osm-search-row .form-input{flex:1;}
  .osm-search-btn{flex-shrink:0;padding:0.68rem 1rem;background:#C05A2A;color:#FAF7F2;border:none;border-radius:6px;font-size:0.82rem;font-weight:500;cursor:pointer;white-space:nowrap;transition:background 0.2s;font-family:'DM Sans',sans-serif;}
  .osm-search-btn:hover:not(:disabled){background:#A34A20;} .osm-search-btn:disabled{opacity:0.55;cursor:not-allowed;}
  .osm-suggestions{position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1.5px solid #E0D6C8;border-radius:8px;z-index:500;max-height:220px;overflow-y:auto;}
  .osm-suggestion{padding:0.55rem 0.8rem;font-size:0.83rem;cursor:pointer;border-bottom:1px solid #F0E8DC;line-height:1.4;} .osm-suggestion:last-child{border-bottom:none;} .osm-suggestion:hover{background:#FFF8F4;}
  .osm-sug-main{font-weight:500;} .osm-sug-sub{font-size:0.71rem;color:#8A7A6A;margin-top:1px;}
  .osm-no-result{padding:0.65rem 0.8rem;font-size:0.82rem;color:#8A7A6A;text-align:center;}
  .osm-map-placeholder{height:218px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.4rem;color:#BDB4A8;font-size:0.78rem;text-align:center;padding:1rem;}
  .osm-map-placeholder-icon{font-size:1.75rem;margin-bottom:0.25rem;}
  .loc-chip{display:flex;align-items:flex-start;gap:0.45rem;padding:0.5rem 0.75rem;background:#F5E8DF;border:1.5px solid #E8C8B0;border-radius:6px;font-size:0.81rem;color:#7A3A15;}
  .loc-chip-text{flex:1;line-height:1.4;word-break:break-word;}
  .loc-chip-coords{font-size:0.66rem;color:#9A6040;white-space:nowrap;margin-top:1px;}
  .loc-chip-clear{cursor:pointer;font-size:0.95rem;color:#C05A2A;background:none;border:none;line-height:1;padding:0;flex-shrink:0;}
  .osm-credit{font-size:0.64rem;color:#BDB4A8;text-align:right;padding:0 0.4rem 0.3rem;} .osm-credit a{color:#BDB4A8;text-decoration:none;}

  /* MODAL */
  .modal-overlay{position:fixed;inset:0;background:rgba(28,28,26,0.6);z-index:8000;display:flex;align-items:center;justify-content:center;padding:1rem;animation:fadeIn 0.2s ease;}
  @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
  .modal{background:#fff;border-radius:14px;padding:2rem;max-width:400px;width:100%;position:relative;animation:scaleIn 0.2s ease;}
  @keyframes scaleIn{from{opacity:0;transform:scale(0.94);}to{opacity:1;transform:scale(1);}}
  .modal-close{position:absolute;top:1rem;right:1rem;background:none;border:none;font-size:1.2rem;cursor:pointer;color:#8A7A6A;padding:0.2rem;}
  .modal-close:hover{color:#1C1C1A;}
  .modal-icon{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:1rem;}
  .modal-icon.blue{background:#E6F1FB;} .modal-icon.amber{background:#FEF8E7;} .modal-icon.green{background:#EDFAF3;} .modal-icon.red{background:#FCF0F0;}
  .modal-title{font-family:'DM Serif Display',serif;font-size:1.35rem;color:#1C1C1A;margin-bottom:0.2rem;}
  .modal-sub{font-size:0.82rem;color:#8A7A6A;margin-bottom:1.25rem;line-height:1.55;}
  .contact-row{display:flex;align-items:center;gap:0.65rem;padding:0.65rem 0.85rem;background:#FAF7F2;border:1px solid #E8E0D4;border-radius:8px;margin-bottom:0.6rem;}
  .contact-icon{width:32px;height:32px;border-radius:50%;background:#F5E8DF;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
  .contact-label{font-size:0.7rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8A7A6A;margin-bottom:1px;}
  .contact-value{font-size:0.9rem;font-weight:500;color:#1C1C1A;}
  .modal-cta{width:100%;margin-top:0.6rem;padding:0.78rem;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:0.88rem;font-weight:500;cursor:pointer;transition:background 0.2s;display:flex;align-items:center;justify-content:center;gap:0.4rem;text-decoration:none;border:none;}
  .modal-cta.primary{background:#C05A2A;color:#FAF7F2;} .modal-cta.primary:hover{background:#A34A20;}
  .modal-cta.secondary{background:#F5E8DF;color:#7A3A15;} .modal-cta.secondary:hover{background:#EBDACE;}
  .modal-cta.green{background:#2DA861;color:#fff;} .modal-cta.green:hover{background:#1F8A4A;}
  .modal-cta.danger{background:#FCF0F0;color:#9A2828;border:1px solid #F5BFBF;} .modal-cta.danger:hover{background:#F7C1C1;}

  /* UPI */
  .upi-amount-box{background:#FAF7F2;border:1px solid #E8E0D4;border-radius:10px;padding:1.25rem;text-align:center;margin:1rem 0;}
  .upi-amount-label{font-size:0.72rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#8A7A6A;margin-bottom:0.4rem;}
  .upi-amount-value{font-family:'DM Serif Display',serif;font-size:2.5rem;color:#1C1C1A;}
  .upi-amount-note{font-size:0.72rem;color:#BDB4A8;margin-top:0.3rem;}
  .upi-id-box{background:#EDFAF3;border:1px solid #C0E8D0;border-radius:6px;padding:0.5rem 0.85rem;font-size:0.88rem;font-weight:500;color:#1B7A45;text-align:center;margin:0.5rem 0;}
  .upi-steps{padding:0;margin:0.75rem 0;}
  .upi-step{display:flex;align-items:flex-start;gap:0.65rem;margin-bottom:0.55rem;font-size:0.83rem;color:#6E6257;}
  .upi-step-num{width:20px;height:20px;border-radius:50%;background:#F5E8DF;color:#C05A2A;display:flex;align-items:center;justify-content:center;font-size:0.68rem;font-weight:700;flex-shrink:0;margin-top:1px;}

  /* MATCHES */
  .matches-page{max-width:860px;margin:0 auto;padding:2.5rem 1.5rem 5rem;}
  .matches-header{margin-bottom:2rem;display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;}
  .matches-title{font-family:'DM Serif Display',serif;font-size:2rem;line-height:1.15;color:#1C1C1A;}
  .matches-sub{font-size:0.85rem;color:#8A7A6A;margin-top:0.3rem;}
  .matches-stats{display:flex;gap:0.75rem;flex-wrap:wrap;}
  .stat-chip{font-size:0.75rem;font-weight:600;padding:0.35rem 0.75rem;border-radius:20px;letter-spacing:0.04em;}
  .stat-chip.high{background:#EDFAF3;color:#1B7A45;border:1px solid #C0E8D0;}
  .stat-chip.med{background:#FEF8E7;color:#8A6200;border:1px solid #F0DFA0;}
  .stat-chip.low{background:#F5F2EE;color:#6E6257;border:1px solid #E0D6C8;}
  .section-label{display:flex;align-items:center;gap:0.65rem;margin-bottom:1rem;}
  .section-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
  .section-dot.high{background:#2DA861;} .section-dot.med{background:#E8A720;} .section-dot.low{background:#BDB4A8;}
  .section-name{font-family:'DM Serif Display',serif;font-size:1.1rem;color:#1C1C1A;}
  .section-count{font-size:0.72rem;font-weight:500;color:#8A7A6A;background:#F0E8DC;padding:0.18rem 0.45rem;border-radius:3px;margin-left:auto;}
  .section-divider{flex:1;height:1px;background:#E8E0D4;}
  .cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1rem;margin-bottom:2.5rem;}
  .match-card{background:#FFFFFF;border:1px solid #E8E0D4;border-radius:10px;padding:1.25rem;position:relative;transition:transform 0.2s;}
  .match-card:hover{transform:translateY(-2px);}
  .match-card.high{border-left:3px solid #2DA861;} .match-card.med{border-left:3px solid #E8A720;} .match-card.low{border-left:3px solid #BDB4A8;}
  .match-card.is-reserved{border-left-color:#185FA5!important;}
  .reserved-tag{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.62rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:0.2rem 0.55rem;border-radius:3px;background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;}
  .visit-count-badge{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.62rem;font-weight:600;padding:0.2rem 0.5rem;border-radius:3px;background:#FEF8E7;color:#8A6200;border:1px solid #F0DFA0;margin-left:0.35rem;}
  .card-rent{font-family:'DM Serif Display',serif;font-size:1.6rem;color:#1C1C1A;}
  .card-rent sup{font-family:'DM Sans',sans-serif;font-size:0.82rem;font-weight:400;color:#8A7A6A;vertical-align:super;}
  .card-budget{font-family:'DM Serif Display',serif;font-size:1.1rem;color:#1C1C1A;}
  .card-period{font-size:0.72rem;color:#8A7A6A;margin-bottom:0.75rem;}
  .card-divider{height:1px;background:#F0E8DC;margin:0.6rem 0;}
  .card-detail{display:flex;align-items:flex-start;gap:0.45rem;font-size:0.79rem;color:#6E6257;margin-bottom:0.38rem;}
  .card-detail svg{flex-shrink:0;opacity:0.55;margin-top:2px;}
  .card-footer{margin-top:0.9rem;display:flex;gap:0.4rem;flex-wrap:wrap;}
  .card-btn{flex:1;min-width:56px;padding:0.45rem 0.5rem;border-radius:5px;font-family:'DM Sans',sans-serif;font-size:0.7rem;font-weight:500;cursor:pointer;border:1px solid #E0D6C8;background:#FDFCFA;color:#6E6257;transition:all 0.15s;text-align:center;}
  .card-btn:hover{background:#F0E8DC;border-color:#C4B8A8;color:#1C1C1A;}
  .card-btn.contact{background:#C05A2A;color:#FAF7F2;border-color:#C05A2A;} .card-btn.contact:hover{background:#A34A20;}
  .card-btn.reserve{background:#185FA5;color:#FAF7F2;border-color:#185FA5;} .card-btn.reserve:hover{background:#0D4A87;}
  .card-btn.reserved-btn{background:#E6F1FB;color:#185FA5;border-color:#B5D4F4;cursor:default;pointer-events:none;}
  .card-btn.visit-done{background:#FEF8E7;color:#8A6200;border-color:#F0DFA0;} .card-btn.visit-done:hover{background:#F5E0A0;}

  /* Listing page */
  .listing-summary{background:#fff;border:1px solid #E8E0D4;border-radius:10px;padding:1.25rem;margin-bottom:2rem;}
  .listing-label{font-size:0.7rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#1B7A45;margin-bottom:0.5rem;}
  .listing-rent{font-family:'DM Serif Display',serif;font-size:1.5rem;color:#1C1C1A;}
  .listing-meta{font-size:0.82rem;color:#6E6257;margin-top:0.3rem;}
  .refresh-btn{display:flex;align-items:center;gap:0.4rem;padding:0.5rem 1rem;border:1.5px solid #B5D4F4;border-radius:8px;background:#E6F1FB;color:#185FA5;font-size:0.78rem;font-weight:500;cursor:pointer;transition:all 0.2s;font-family:'DM Sans',sans-serif;}
  .refresh-btn:hover{background:#CCE4F7;} .refresh-btn:disabled{opacity:0.6;cursor:not-allowed;}

  .state-box{text-align:center;padding:4rem 2rem;}
  .state-box h3{font-family:'DM Serif Display',serif;font-size:1.5rem;color:#1C1C1A;margin-bottom:0.5rem;}
  .state-box p{font-size:0.88rem;color:#8A7A6A;line-height:1.6;max-width:320px;margin:0 auto;}
  .state-icon{font-size:2.5rem;margin-bottom:1rem;}
  .success-page{max-width:520px;margin:0 auto;padding:4rem 1.5rem;text-align:center;}
  .success-icon{width:64px;height:64px;background:#EDFAF3;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;font-size:28px;}
  .success-title{font-family:'DM Serif Display',serif;font-size:2rem;color:#1C1C1A;margin-bottom:0.75rem;}
  .success-sub{font-size:0.9rem;color:#8A7A6A;line-height:1.7;max-width:340px;margin:0 auto 2rem;}

  .btn-primary{background:#C05A2A;color:#FAF7F2;border:none;padding:0.85rem 2.2rem;border-radius:4px;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:500;cursor:pointer;transition:all 0.2s;}
  .btn-primary:hover{background:#A34A20;transform:translateY(-1px);}
  .btn-outline{background:transparent;color:#1C1C1A;border:1.5px solid #C4B8A8;padding:0.85rem 2.2rem;border-radius:4px;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:500;cursor:pointer;transition:all 0.2s;}
  .btn-outline:hover{border-color:#1C1C1A;background:#F0E8DC;transform:translateY(-1px);}

  /* MY LISTINGS TAB SWITCHER */
  .my-listings-tabs{display:flex;background:#F0E8DC;border-radius:10px;padding:4px;gap:3px;margin-bottom:2rem;}
  .my-listings-tab{flex:1;padding:0.55rem 1rem;border-radius:7px;border:none;font-family:'DM Sans',sans-serif;font-size:0.85rem;font-weight:500;cursor:pointer;transition:all 0.2s;color:#8A7A6A;background:transparent;text-align:center;}
  .my-listings-tab.active{background:#fff;color:#1C1C1A;box-shadow:0 1px 4px rgba(28,28,26,0.1);}
  .my-listings-tab:not(.active):hover{background:#E8D8CC;color:#1C1C1A;}

  /* SEARCH INFO BOX (read-only summary of last search) */
  .search-info-box{background:#fff;border:1px solid #E8E0D4;border-radius:10px;padding:1.25rem;margin-bottom:1.5rem;}
  .search-info-label{font-size:0.7rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#185FA5;margin-bottom:0.65rem;display:flex;align-items:center;justify-content:space-between;}
  .search-info-label button{font-size:0.72rem;font-weight:500;color:#C05A2A;background:none;border:1px solid #E8C8B0;border-radius:4px;padding:0.2rem 0.55rem;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s;}
  .search-info-label button:hover{background:#F5E8DF;}
  .search-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.5rem 1rem;}
  @media(max-width:480px){.search-info-grid{grid-template-columns:1fr;}}
  .search-info-item{display:flex;flex-direction:column;gap:2px;}
  .search-info-key{font-size:0.68rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8A7A6A;}
  .search-info-val{font-size:0.85rem;color:#1C1C1A;font-weight:500;}
  .search-info-full{grid-column:1/-1;}

  /* VISIT DONE DISABLED */
  .card-btn.visit-done-disabled{background:#F5F2EE;color:#BDB4A8;border-color:#E0D6C8;cursor:not-allowed;pointer-events:none;}
`;


// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
function Toast({ message, type, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 4500); return () => clearTimeout(t); }, [onDone]);
  return <div className={`toast ${type}`}>{message}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// BHK CHECKBOX GROUP
// ─────────────────────────────────────────────────────────────────────────────
function BhkSelector({ selected, onChange, error }) {
  const toggle = (opt) => {
    const next = selected.includes(opt)
      ? selected.filter(x => x !== opt)
      : [...selected, opt];
    onChange(next);
  };
  return (
    <div>
      <div className="bhk-group">
        {BHK_OPTIONS.map(opt => (
          <label key={opt} className={`bhk-chip${selected.includes(opt) ? " selected" : ""}`} onClick={() => toggle(opt)}>
            <span className="bhk-check">{selected.includes(opt) ? "✓" : ""}</span>
            {opt}
          </label>
        ))}
      </div>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT MODAL
// ─────────────────────────────────────────────────────────────────────────────
function ContactModal({ name, mobile, role, onClose }) {
  useEffect(() => {
    const esc = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const clean = String(mobile).replace(/[^\d]/g, "");
  const dial  = clean.startsWith("91") ? `+${clean}` : `+91${clean}`;
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="modal-icon blue">📞</div>
        <div className="modal-title">{role} Contact</div>
        <div className="modal-sub">Contact details for this listing</div>
        <div className="contact-row"><div className="contact-icon">👤</div><div><div className="contact-label">Name</div><div className="contact-value">{name || "—"}</div></div></div>
        <div className="contact-row"><div className="contact-icon">📱</div><div><div className="contact-label">Mobile</div><div className="contact-value">+91 {mobile || "—"}</div></div></div>
        <a className="modal-cta primary" href={`tel:${dial}`}>📞 Call Now</a>
        <button className="modal-cta secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT MODAL
// ─────────────────────────────────────────────────────────────────────────────
function PaymentModal({ card, user, onClose, onPaid }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const upiLink = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(UPI_NAME)}&am=${UPI_AMOUNT}&cu=INR&tn=${encodeURIComponent(`Reserve ${card.id}`)}`;

  useEffect(() => {
    const esc = e => { if (e.key === "Escape" && step < 3) onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose, step]);

  const handleIHavePaid = async () => {
    setSaving(true);
    const now = new Date().toLocaleString("en-IN");
    const res = {
      "Reservation ID":    `R-${Date.now()}`,
      "Reserved At":       now,
      "Tenant Name":       `${user.firstName} ${user.lastName}`,
      "Tenant Mobile":     user.mobile,
      "Owner Name":        card.ownerName   || "—",
      "Owner Mobile":      card.ownerMobile || "—",
      "Submission ID":     card.id,
      "Property Location": card.location,
      "Monthly Rent (₹)":  card.rent,
      "Amount Paid (₹)":   UPI_AMOUNT,
      "Status":            "Reserved",
      "Visit Count":       0,
    };
    try { await postToSheet("Reservations", res); } catch (_) {}
    setSaving(false);
    setStep(3);
    onPaid(card.id);
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && step < 3 && onClose()}>
      <div className="modal">
        {step < 3 && <button className="modal-close" onClick={onClose}>✕</button>}
        {step === 1 && (
          <>
            <div className="modal-icon amber">🏠</div>
            <div className="modal-title">Reserve this property</div>
            <div className="modal-sub">Pay a token amount to reserve your spot.</div>
            <div className="upi-amount-box">
              <div className="upi-amount-label">Token Amount</div>
              <div className="upi-amount-value">₹{UPI_AMOUNT}</div>
              <div className="upi-amount-note">Amount is fixed — cannot be modified</div>
            </div>
            <div className="contact-row"><div className="contact-icon">📍</div><div><div className="contact-label">Property</div><div className="contact-value">{card.location}</div></div></div>
            <div className="contact-row"><div className="contact-icon">💰</div><div><div className="contact-label">Monthly Rent</div><div className="contact-value">₹{Number(card.rent).toLocaleString("en-IN")}</div></div></div>
            <button className="modal-cta primary" style={{marginTop:"1rem"}} onClick={() => setStep(2)}>Proceed to Pay →</button>
            <button className="modal-cta secondary" onClick={onClose}>Cancel</button>
          </>
        )}
        {step === 2 && (
          <>
            <div className="modal-icon amber">💳</div>
            <div className="modal-title">Complete UPI Payment</div>
            <div className="modal-sub">Pay exactly ₹{UPI_AMOUNT} — do not change the amount.</div>
            <div className="upi-amount-box">
              <div className="upi-amount-label">Pay exactly</div>
              <div className="upi-amount-value">₹{UPI_AMOUNT}</div>
              <div className="upi-amount-note">Do not change the amount</div>
            </div>
            <div className="upi-id-box">UPI ID: {UPI_ID}</div>
            <ol className="upi-steps">
              <li className="upi-step"><span className="upi-step-num">1</span>Tap "Open UPI App" below</li>
              <li className="upi-step"><span className="upi-step-num">2</span>Complete the ₹{UPI_AMOUNT} payment</li>
              <li className="upi-step"><span className="upi-step-num">3</span>Return here and tap "I Have Paid"</li>
            </ol>
            <a className="modal-cta primary" href={upiLink} target="_blank" rel="noreferrer">📲 Open UPI App</a>
            <button className="modal-cta green" style={{marginTop:"0.5rem"}} onClick={handleIHavePaid} disabled={saving}>
              {saving ? <><div className="spinner" />Confirming…</> : "✓ I Have Paid"}
            </button>
            <button className="modal-cta danger" onClick={onClose}>✕ Cancel Payment</button>
          </>
        )}
        {step === 3 && (
          <>
            <div className="modal-icon green">✓</div>
            <div className="modal-title">Property Reserved!</div>
            <div className="modal-sub">Your reservation for <strong>{card.location}</strong> has been recorded. The owner will be notified.</div>
            <div className="contact-row"><div className="contact-icon">👤</div><div><div className="contact-label">Owner</div><div className="contact-value">{card.ownerName}</div></div></div>
            <div className="contact-row"><div className="contact-icon">📱</div><div><div className="contact-label">Owner Mobile</div><div className="contact-value">+91 {card.ownerMobile}</div></div></div>
            <button className="modal-cta green" style={{marginTop:"1rem"}} onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OSM MAP
// ─────────────────────────────────────────────────────────────────────────────
function OSMMap({ lat, lng, onMove }) {
  const divRef = useRef(null), mapRef = useRef(null), markerRef = useRef(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { let live = true; loadLeaflet().then(() => { if (live) setReady(true); }); return () => { live = false; }; }, []);
  useEffect(() => {
    if (!ready || !divRef.current || mapRef.current) return;
    const L = window.L, map = L.map(divRef.current, { zoomControl: true }).setView([lat, lng], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OSM</a>' }).addTo(map);
    const icon = L.divIcon({ html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36"><path d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z" fill="#C05A2A" stroke="#fff" stroke-width="1.5"/><circle cx="14" cy="14" r="5.5" fill="#FAF7F2"/></svg>`, className: "", iconSize: [28, 36], iconAnchor: [14, 36] });
    const marker = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
    marker.on("dragend", e => { const { lat: la, lng: lo } = e.target.getLatLng(); onMove(la, lo); });
    map.on("click", e => { marker.setLatLng(e.latlng); onMove(e.latlng.lat, e.latlng.lng); });
    mapRef.current = map; markerRef.current = marker;
  }, [ready]);
  useEffect(() => { if (!mapRef.current || !markerRef.current) return; mapRef.current.setView([lat, lng], 15, { animate: true }); markerRef.current.setLatLng([lat, lng]); }, [lat, lng]);
  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);
  if (!ready) return <div className="osm-map-loading"><div className="spinner-dark" /> Loading map…</div>;
  return <div ref={divRef} className="osm-map" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION FIELD — search on left, map on right (side-by-side)
// ─────────────────────────────────────────────────────────────────────────────
function LocationField({ location, onSelect, onClear, error }) {
  const [query,       setQuery]       = useState(location.address || "");
  const [suggestions, setSuggestions] = useState([]);
  const [searching,   setSearching]   = useState(false);
  const [showMap,     setShowMap]     = useState(!!location.address);
  const [mapCoords,   setMapCoords]   = useState({ lat: location.lat || 19.9975, lng: location.lng || 73.7898 });
  const debounce = useRef(null), wrapRef = useRef(null);

  useEffect(() => {
    const close = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setSuggestions([]); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const doSearch = async q => { setSearching(true); try { setSuggestions(await nominatimSearch(q)); } finally { setSearching(false); } };
  const handleInput = val => { setQuery(val); clearTimeout(debounce.current); if (val.length >= 3) debounce.current = setTimeout(() => doSearch(val), 420); else setSuggestions([]); };
  const pick = item => {
    const lat = parseFloat(item.lat), lng = parseFloat(item.lon), addr = item.display_name;
    setQuery(addr); setSuggestions([]); setMapCoords({ lat, lng }); setShowMap(true);
    onSelect({ address: addr, lat, lng });
  };
  const handleMapMove = useCallback(async (lat, lng) => {
    setMapCoords({ lat, lng });
    try { const data = await nominatimReverse(lat, lng); const addr = data?.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`; setQuery(addr); onSelect({ address: addr, lat, lng }); }
    catch { const addr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; setQuery(addr); onSelect({ address: addr, lat, lng }); }
  }, [onSelect]);
  const handleClear = () => { setQuery(""); setSuggestions([]); setShowMap(false); setMapCoords({ lat: 19.9975, lng: 73.7898 }); onClear(); };
  const fmt = item => { const p = item.display_name.split(", "); return { main: p.slice(0, 2).join(", "), sub: p.slice(2, 5).join(", ") }; };

  return (
    <div className="osm-field" ref={wrapRef}>
      {/* Two-column: search+chip left, map right */}
      <div className="osm-layout">
        {/* LEFT — search bar, suggestions, selected chip */}
        <div className="osm-left">
          <div className="osm-search-row">
            <input
              className={`form-input${error ? " error" : ""}`}
              placeholder="Type area, street or city…"
              value={query}
              onChange={e => handleInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && suggestions.length) pick(suggestions[0]); }}
              autoComplete="off"
            />
            <button className="osm-search-btn" disabled={searching || query.length < 3} onClick={() => doSearch(query)}>
              {searching ? "…" : "Search"}
            </button>
          </div>

          {/* Dropdown suggestions */}
          {suggestions.length > 0 && (
            <div className="osm-suggestions">
              {suggestions.map(item => {
                const { main, sub } = fmt(item);
                return (
                  <div key={item.place_id} className="osm-suggestion" onClick={() => pick(item)}>
                    <div className="osm-sug-main">📍 {main}</div>
                    {sub && <div className="osm-sug-sub">{sub}</div>}
                  </div>
                );
              })}
            </div>
          )}
          {!searching && !suggestions.length && query.length >= 3 && !showMap && (
            <div className="osm-suggestions"><div className="osm-no-result">No results found</div></div>
          )}

          {/* Selected chip */}
          {location.address && (
            <div className="loc-chip">
              <span>📍</span>
              <div style={{ flex: 1 }}>
                <div className="loc-chip-text">{location.address}</div>
                {location.lat != null && (
                  <div className="loc-chip-coords">{location.lat.toFixed(4)}, {location.lng.toFixed(4)}</div>
                )}
              </div>
              <button className="loc-chip-clear" onClick={handleClear} title="Change location">✕</button>
            </div>
          )}

          {error && !location.address && <span className="form-error">{error}</span>}
        </div>

        {/* RIGHT — map (always shown; placeholder before location picked) */}
        <div className="osm-right">
          {showMap ? (
            <>
              <OSMMap lat={mapCoords.lat} lng={mapCoords.lng} onMove={handleMapMove} />
              <div className="osm-map-hint-text">
                <span>🖱</span> Drag pin or click to adjust
              </div>
              <p className="osm-credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></p>
            </>
          ) : (
            <div className="osm-map-placeholder">
              <div className="osm-map-placeholder-icon">🗺️</div>
              <div>Search for a location to see the map</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// PROFILE DROPDOWN
// ─────────────────────────────────────────────────────────────────────────────
function ProfileBtn({ user, onLogout, onMyListings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const initials = `${user.firstName[0]}${user.lastName[0]}`.toUpperCase();
  useEffect(() => { const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <div className="profile-btn" onClick={() => setOpen(o => !o)}>
        <div className="avatar">{initials}</div>
        <span className="profile-name">{user.firstName}</span>
        <span style={{ fontSize: "0.65rem", color: "#BDB4A8" }}>▾</span>
      </div>
      {open && (
        <div className="profile-dropdown">
          <div className="profile-dropdown-header">
            <div className="profile-dropdown-name">{user.firstName} {user.lastName}</div>
            <div className="profile-dropdown-mobile">+91 {user.mobile}</div>
          </div>
          <button className="dropdown-item listings" onClick={() => { setOpen(false); onMyListings(); }}>🏠 My Listings &amp; Matches</button>
          <button className="dropdown-item logout" onClick={() => { setOpen(false); onLogout(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVBAR — with role switcher
// ─────────────────────────────────────────────────────────────────────────────
function Navbar({ page, setPage, user, role, setRole, onLogout, onMyListings }) {
  const showBack = user && !["home", "landing"].includes(page);
  const handleRoleSwitch = r => { setRole(r); setPage(r); };
  return (
    <nav className="nav">
      <div className="nav-logo" onClick={() => user ? setPage("home") : setPage("landing")}>nest<span>match</span></div>
      <div className="nav-right">
        {user && (
          <div className="role-switch">
            <button className={`role-tab${role === "tenant" ? " active" : ""}`} onClick={() => handleRoleSwitch("tenant")}>Tenant</button>
            <button className={`role-tab${role === "owner" ? " active" : ""}`}  onClick={() => handleRoleSwitch("owner")}>Owner</button>
          </div>
        )}
        {showBack && <button className="nav-btn back" onClick={() => setPage("home")}>← Home</button>}
        {user && <ProfileBtn user={user} onLogout={onLogout} onMyListings={onMyListings} />}
      </div>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDING PAGE (pre-login)
// ─────────────────────────────────────────────────────────────────────────────
function LandingPage({ setPage }) {
  return (
    <div className="landing">
      <p className="landing-eyebrow">Real Estate Rental Matching</p>
      <h1 className="landing-title">Find your <em>perfect</em> home, faster</h1>
      <p className="landing-sub">Smart rental matching for tenants and owners — no agents, no brokerage, no hassle.</p>
      <div className="landing-btns">
        <button className="btn-hero solid" onClick={() => setPage("signup")}>Find My Nest</button>
        <button className="btn-hero ghost" onClick={() => setPage("login")}>Back to the Nest</button>
      </div>
      <div className="landing-badges">
        <span className="landing-badge">Free to use</span>
        <span className="landing-badge">Verified listings</span>
        <span className="landing-badge">Instant matches</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATED HOME PAGE (post-login)
// ─────────────────────────────────────────────────────────────────────────────
function AnimatedHouse() {
  return (
    <div className="house-wrap">
      <div className="home-scene">
        {/* Stars */}
        <div className="star" style={{top:"10px",left:"20px",animationDelay:"0s"}} />
        <div className="star" style={{top:"5px",left:"80px",animationDelay:"0.7s"}} />
        <div className="star" style={{top:"15px",right:"30px",animationDelay:"1.3s"}} />
        <div className="star" style={{top:"8px",right:"90px",animationDelay:"0.4s"}} />
        {/* Smoke */}
        <div className="smoke smoke1" /><div className="smoke smoke2" /><div className="smoke smoke3" />
        {/* Chimney */}
        <div className="chimney" />
        {/* Roof */}
        <div className="roof" /><div className="roof-edge" />
        {/* House body */}
        <div className="house-body">
          <div className="window left window-glow" />
          <div className="window right window-glow" />
          <div className="door"><div className="door-knob" /><div className="door-line" /></div>
        </div>
        {/* Path */}
        <div className="path" />
        {/* Ground */}
        <div className="ground">
          <div className="grass-blade" style={{left:"12%",animationDelay:"0s"}} />
          <div className="grass-blade" style={{left:"22%",animationDelay:"0.4s"}} />
          <div className="grass-blade" style={{left:"60%",animationDelay:"0.8s"}} />
          <div className="grass-blade" style={{left:"72%",animationDelay:"0.2s"}} />
          <div className="grass-blade" style={{left:"85%",animationDelay:"1s"}} />
        </div>
      </div>
    </div>
  );
}

function HomePage({ setPage, user, role, setRole }) {
  const handleGo = (r) => { setRole(r); setPage(r); };
  return (
    <div className="home-page">
      <AnimatedHouse />
      <h1 className="home-greeting">Welcome home, <em>friend</em>.</h1>
      <p className="home-sub-text">You're exactly where you need to be to find your next place.</p>
      <p className="home-role-prompt">What would you like to do today, {user.firstName}?</p>
      <div className="home-cta-row">
        <button className="btn-hero solid" onClick={() => handleGo("tenant")}>🔍 Search Properties</button>
        <button className="btn-hero ghost" onClick={() => handleGo("owner")}>🏠 List My Property</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD STRENGTH
// ─────────────────────────────────────────────────────────────────────────────
function pwStrength(pw) {
  if (!pw) return { score: 0, label: "", color: "", width: "0%" };
  let s = 0;
  if (pw.length >= 9) s++; if (/[A-Z]/.test(pw)) s++; if (/[0-9]/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
  return { score: s, label: ["", "Weak", "Fair", "Good", "Strong"][s], color: ["", "#E24B4A", "#E8A720", "#3B9EFF", "#2DA861"][s], width: `${s * 25}%` };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNUP
// ─────────────────────────────────────────────────────────────────────────────
function SignupPage({ setPage, showToast }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", mobile: "", password: "", confirmPw: "" });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const strength = pwStrength(form.password);

  const validate = () => {
    const e = {};
    if (!form.firstName) e.firstName = "Required"; else if (form.firstName.length > 20) e.firstName = "Max 20 chars"; else if (/[^a-zA-Z\s]/.test(form.firstName)) e.firstName = "No special characters";
    if (!form.lastName)  e.lastName  = "Required"; else if (form.lastName.length > 20)  e.lastName  = "Max 20 chars"; else if (/[^a-zA-Z\s]/.test(form.lastName))  e.lastName  = "No special characters";
    if (!form.mobile)  e.mobile  = "Required"; else if (!/^\d{5,10}$/.test(form.mobile)) e.mobile = "5–10 digits after +91";
    if (!form.password) e.password = "Required"; else if (form.password.length < 9) e.password = "Min 9 characters"; else if (form.password.length > 15) e.password = "Max 15 characters"; else if (!/[A-Z]/.test(form.password)) e.password = "Need at least one capital letter"; else if (!/[0-9]/.test(form.password)) e.password = "Need at least one number";
    if (!form.confirmPw) e.confirmPw = "Required"; else if (form.password !== form.confirmPw) e.confirmPw = "Passwords do not match";
    return e;
  };

  const submit = async () => {
    const e = validate(); if (Object.keys(e).length) { setErrors(e); return; }
    setLoading(true); setConnecting(true);
    try {
      const check = await checkDuplicate(form.mobile);
      if (check.exists) { setErrors({ mobile: "This mobile is already registered" }); setLoading(false); setConnecting(false); return; }
      const hashed = await hashPassword(form.password);
      await postToSheet("Users", { "Registered At": new Date().toLocaleString("en-IN"), "First Name": form.firstName.trim(), "Last Name": form.lastName.trim(), "Mobile": form.mobile, "Password Hash": hashed });
      showToast("Account created! Please log in.", "success");
      setPage("login");
    } catch (err) { showToast("Signup failed: " + err.message, "error"); }
    finally { setLoading(false); setConnecting(false); }
  };

  return (
    <div className="auth-page"><div className="auth-card">
      <div className="auth-logo">nest<span>match</span></div>
      <h1 className="auth-title">Create your account</h1>
      <p className="auth-sub">Already have an account? <a onClick={() => setPage("login")}>Back to the Nest</a></p>
      {connecting && <div className="auth-connecting">⏳ Connecting to server… (first connection may take a few seconds)</div>}
      <div className="form-row">
        <div className="form-group"><label className="form-label">First Name <span className="required">*</span></label><input className={`form-input${errors.firstName ? " error" : ""}`} placeholder="Ravi" maxLength={20} value={form.firstName} onChange={set("firstName")} />{errors.firstName && <span className="form-error">{errors.firstName}</span>}</div>
        <div className="form-group"><label className="form-label">Last Name <span className="required">*</span></label><input className={`form-input${errors.lastName ? " error" : ""}`} placeholder="Sharma" maxLength={20} value={form.lastName} onChange={set("lastName")} />{errors.lastName && <span className="form-error">{errors.lastName}</span>}</div>
      </div>
      <div className="form-group"><label className="form-label">Mobile Number <span className="required">*</span></label><div className={`phone-row${errors.mobile ? " error" : ""}`}><span className="phone-prefix">+91</span><input className="phone-input" type="tel" placeholder="98765 43210" maxLength={10} value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value.replace(/\D/g, "") }))} /></div>{errors.mobile && <span className="form-error">{errors.mobile}</span>}</div>
      <div className="form-group"><label className="form-label">Create Password <span className="required">*</span></label><div className="pw-wrap"><input className={`form-input${errors.password ? " error" : ""}`} type={showPw ? "text" : "password"} placeholder="Min 9 chars, 1 capital, 1 number" maxLength={15} value={form.password} onChange={set("password")} /><button className="pw-toggle" onClick={() => setShowPw(s => !s)} type="button">{showPw ? "Hide" : "Show"}</button></div>{form.password && <><div className="pw-strength"><div className="pw-strength-fill" style={{ width: strength.width, background: strength.color }} /></div><div className="pw-hint" style={{ color: strength.color }}>{strength.label}</div></>}{errors.password && <span className="form-error">{errors.password}</span>}</div>
      <div className="form-group"><label className="form-label">Confirm Password <span className="required">*</span></label><input className={`form-input${errors.confirmPw ? " error" : ""}`} type="password" placeholder="Repeat password" value={form.confirmPw} onChange={set("confirmPw")} />{errors.confirmPw && <span className="form-error">{errors.confirmPw}</span>}</div>
      <div className="submit-row"><button className="btn-submit" onClick={submit} disabled={loading}>{loading ? <><div className="spinner" />{connecting ? "Connecting…" : "Creating account…"}</> : "Sign Up →"}</button></div>
    </div></div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
function LoginPage({ setPage, onLogin, showToast }) {
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const submit = async () => {
    const e = {};
    if (!mobile) e.mobile = "Required"; else if (!/^\d{5,10}$/.test(mobile)) e.mobile = "Digits only after +91";
    if (!password) e.password = "Required";
    if (Object.keys(e).length) { setErrors(e); return; }
    setLoading(true); setConnecting(true); setAttempt(0);
    try {
      const hashed = await hashPassword(password);
      // Show retry count in UI
      let res;
      for (let i = 0; i < 3; i++) {
        setAttempt(i + 1);
        try {
          const r = await fetch(`${SHEET_URL}?action=login&mobile=${encodeURIComponent(mobile)}&hash=${encodeURIComponent(hashed)}`, { cache: "no-store" });
          if (r.ok) { res = await r.json(); break; }
        } catch (_) {}
        if (i < 2) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      }
      if (!res) throw new Error("Could not reach server after 3 attempts");
      if (!res.success) { setErrors({ password: res.error || "Mobile number or password is incorrect" }); return; }
      const profile = { firstName: res.user.firstName, lastName: res.user.lastName, mobile: res.user.mobile };
      setSession(profile);
      onLogin(profile);
      showToast(`Welcome back, ${profile.firstName}!`, "success");
    } catch (err) {
      showToast("Login failed — please check your connection and try again.", "error");
    } finally { setLoading(false); setConnecting(false); setAttempt(0); }
  };

  const retryMsg = connecting && attempt > 1 ? `Still connecting… (attempt ${attempt}/3)` : connecting ? "Connecting to server…" : null;

  return (
    <div className="auth-page"><div className="auth-card">
      <div className="auth-logo">nest<span>match</span></div>
      <h1 className="auth-title">Welcome back</h1>
      <p className="auth-sub">New here? <a onClick={() => setPage("signup")}>Find My Nest</a></p>
      {retryMsg && <div className="auth-connecting">{retryMsg}</div>}
      <div className="form-group"><label className="form-label">Mobile Number <span className="required">*</span></label><div className={`phone-row${errors.mobile ? " error" : ""}`}><span className="phone-prefix">+91</span><input className="phone-input" type="tel" placeholder="98765 43210" maxLength={10} value={mobile} onChange={e => setMobile(e.target.value.replace(/\D/g, ""))} /></div>{errors.mobile && <span className="form-error">{errors.mobile}</span>}</div>
      <div className="form-group"><label className="form-label">Password <span className="required">*</span></label><div className="pw-wrap"><input className={`form-input${errors.password ? " error" : ""}`} type={showPw ? "text" : "password"} placeholder="Your password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} /><button className="pw-toggle" onClick={() => setShowPw(s => !s)} type="button">{showPw ? "Hide" : "Show"}</button></div>{errors.password && <span className="form-error">{errors.password}</span>}</div>
      <div className="submit-row"><button className="btn-submit" onClick={submit} disabled={loading}>{loading ? <><div className="spinner" />{retryMsg || "Logging in…"}</> : "Log In →"}</button></div>
    </div></div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TENANT FORM
// ─────────────────────────────────────────────────────────────────────────────
function TenantForm({ setPage, setMatches, showToast, user }) {
  const emptyLoc = { address: "", lat: null, lng: null };
  const [form, setForm] = useState({ budgetMin: "", budgetMax: "", location: emptyLoc, moveIn: "", urgency: "", bhk: [] });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [savedSearches, setSavedSearches] = useState(() => getSavedSearches(user.mobile));
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.budgetMin) e.budgetMin = "Required";
    if (!form.budgetMax) e.budgetMax = "Required";
    if (form.budgetMin && form.budgetMax && +form.budgetMin > +form.budgetMax) e.budgetMax = "Max must be ≥ Min";
    if (!form.location.address) e.location = "Please select a location on the map";
    if (!form.moveIn) e.moveIn = "Required"; else if (form.moveIn < getTomorrow()) e.moveIn = "Must be tomorrow or later";
    if (!form.urgency) e.urgency = "Required";
    if (!form.bhk.length) e.bhk = "Select at least one BHK type";
    return e;
  };

  const submit = async () => {
    const e = validate(); if (Object.keys(e).length) { setErrors(e); return; }
    setLoading(true);
    const bhkStr = form.bhk.join(", ");
    const entry = {
      "Submission ID": `T-${Date.now()}`, "Submitted At": new Date().toLocaleString("en-IN"),
      "User Name": `${user.firstName} ${user.lastName}`, "Mobile": user.mobile,
      "Budget Min (₹)": +form.budgetMin, "Budget Max (₹)": +form.budgetMax,
      "Location": form.location.address, "Latitude": form.location.lat, "Longitude": form.location.lng,
      "Move-in Date": form.moveIn, "Urgency": form.urgency, "BHK Types": bhkStr,
    };
    addTenant(entry);
    // Save search to localStorage (per user) + sync to sheet
    saveSearchLocal(user.mobile, { budgetMin: form.budgetMin, budgetMax: form.budgetMax, location: form.location, moveIn: form.moveIn, urgency: form.urgency, bhk: form.bhk });
    setSavedSearches(getSavedSearches(user.mobile));
    // Sync saved searches to sheet (best-effort)
    postToSheet("SavedSearches", { "User Mobile": user.mobile, "User Name": `${user.firstName} ${user.lastName}`, "Budget Min (₹)": +form.budgetMin, "Budget Max (₹)": +form.budgetMax, "Location": form.location.address, "Move-in Date": form.moveIn, "Urgency": form.urgency, "BHK Types": bhkStr, "Saved At": new Date().toLocaleString("en-IN") }).catch(() => {});
    try {
      await postToSheet("Tenant", entry);
      showToast("Saved! Finding matches…", "info");
      const owners = await fetchSheet("Owner");
      setMatches(buildTenantMatches(entry, owners));
      setPage("matches");
    } catch (err) {
      showToast("⚠ Saved locally, Sheets error: " + err.message, "error");
      setMatches({ high_priority: [], medium: [], low: [] }); setPage("matches");
    } finally { setLoading(false); }
  };

  const loadSearch = s => { setForm({ budgetMin: s.budgetMin, budgetMax: s.budgetMax, location: s.location, moveIn: s.moveIn, urgency: s.urgency, bhk: s.bhk || [] }); setErrors({}); };
  const removeSearch = i => { deleteSavedSearch(user.mobile, i); setSavedSearches(getSavedSearches(user.mobile)); };

  return (
    <div className="form-page">
      <span className="form-tag">Tenant</span>
      <h1 className="form-title">Find your nest</h1>
      <p className="form-desc">Searching as <strong>{user.firstName} {user.lastName}</strong></p>
      <div className="form-card">
        <div className="form-row">
          <div className="form-group"><label className="form-label">Budget Min <span className="required">*</span></label><input className={`form-input${errors.budgetMin ? " error" : ""}`} type="number" placeholder="₹ 10,000" value={form.budgetMin} onChange={set("budgetMin")} />{errors.budgetMin && <span className="form-error">{errors.budgetMin}</span>}</div>
          <div className="form-group"><label className="form-label">Budget Max <span className="required">*</span></label><input className={`form-input${errors.budgetMax ? " error" : ""}`} type="number" placeholder="₹ 30,000" value={form.budgetMax} onChange={set("budgetMax")} />{errors.budgetMax && <span className="form-error">{errors.budgetMax}</span>}</div>
        </div>
        <div className="form-group">
          <label className="form-label">Property Type <span className="required">*</span></label>
          <BhkSelector selected={form.bhk} onChange={bhk => { setForm(f => ({ ...f, bhk })); setErrors(e => ({ ...e, bhk: "" })); }} error={errors.bhk} />
        </div>
        <div className="form-group"><label className="form-label">Preferred Location <span className="required">*</span></label><LocationField location={form.location} onSelect={p => { setForm(f => ({ ...f, location: p })); setErrors(e => ({ ...e, location: "" })); }} onClear={() => setForm(f => ({ ...f, location: emptyLoc }))} error={errors.location} /></div>
        <div className="divider" />
        <div className="form-row">
          <div className="form-group"><label className="form-label">Move-in Date <span className="required">*</span></label><input className={`form-input${errors.moveIn ? " error" : ""}`} type="date" min={getTomorrow()} value={form.moveIn} onChange={set("moveIn")} />{errors.moveIn && <span className="form-error">{errors.moveIn}</span>}</div>
          <div className="form-group"><label className="form-label">Urgency <span className="required">*</span></label><select className={`form-select${errors.urgency ? " error" : ""}`} value={form.urgency} onChange={set("urgency")}><option value="">Select…</option><option>Immediate (0–7 days)</option><option>Soon (15–30 days)</option><option>Flexible (1–3 months)</option></select>{errors.urgency && <span className="form-error">{errors.urgency}</span>}</div>
        </div>
        <div className="submit-row"><button className="btn-submit" onClick={submit} disabled={loading}>{loading ? <><div className="spinner" />Finding matches…</> : "Find My Matches →"}</button></div>
        {savedSearches.length > 0 && (
          <div className="saved-section">
            <div className="saved-title">🔖 Your Saved Searches</div>
            {savedSearches.map((s, i) => (
              <div key={i} className="saved-item" onClick={() => loadSearch(s)}>
                <div className="saved-info">
                  <div className="saved-budget">₹{Number(s.budgetMin).toLocaleString("en-IN")} – ₹{Number(s.budgetMax).toLocaleString("en-IN")} · {(s.bhk || []).join(", ")}</div>
                  <div className="saved-meta">{s.location?.address?.split(",")[0]} · {s.urgency} · {s.savedAt}</div>
                </div>
                <button className="saved-del" onClick={e => { e.stopPropagation(); removeSearch(i); }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER FORM
// ─────────────────────────────────────────────────────────────────────────────
function OwnerForm({ setPage, showToast, user, setOwnerMatches }) {
  const emptyLoc = { address: "", lat: null, lng: null };
  const [form, setForm] = useState({ rent: "", location: emptyLoc, availFrom: "", bhk: [] });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.rent) e.rent = "Required";
    if (!form.location.address) e.location = "Please select a location on the map";
    if (!form.availFrom) e.availFrom = "Required"; else if (form.availFrom < getToday()) e.availFrom = "Cannot be in the past";
    if (!form.bhk.length) e.bhk = "Select at least one BHK type";
    return e;
  };

  const submit = async () => {
    const e = validate(); if (Object.keys(e).length) { setErrors(e); return; }
    setLoading(true);
    const entry = {
      "Submission ID": `O-${Date.now()}`, "Submitted At": new Date().toLocaleString("en-IN"),
      "User Name": `${user.firstName} ${user.lastName}`, "Mobile": user.mobile,
      "Monthly Rent (₹)": +form.rent, "BHK Types": form.bhk.join(", "),
      "Location": form.location.address, "Latitude": form.location.lat, "Longitude": form.location.lng,
      "Available From": form.availFrom,
    };
    addOwner(entry);
    setOwnerListing(user.mobile, entry);
    try {
      await postToSheet("Owner", entry);
      showToast("Property listed! Finding matching tenants…", "info");
      const tenants = await fetchSheet("Tenant");
      const matched = buildOwnerMatches(entry, tenants);
      setMatchCount(matched.high_priority.length + matched.medium.length + matched.low.length);
      setOwnerMatches(matched); setDone(true);
    } catch (err) {
      showToast("⚠ Saved locally, Sheets error: " + err.message, "error"); setDone(true);
    } finally { setLoading(false); }
  };

  if (done) return (
    <div className="success-page">
      <div className="success-icon">✓</div>
      <h2 className="success-title">Property listed!</h2>
      <p className="success-sub">{matchCount > 0 ? `We found ${matchCount} matching ${matchCount === 1 ? "tenant" : "tenants"}!` : "No matching tenants yet — check back soon."}</p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap", marginTop: "1rem" }}>
        {matchCount > 0 && <button className="btn-primary" onClick={() => setPage("owner-matches")}>View Matches ({matchCount})</button>}
        <button className="btn-outline" onClick={() => setPage("home")}>Back to Home</button>
      </div>
    </div>
  );

  return (
    <div className="form-page">
      <span className="form-tag">Owner</span>
      <h1 className="form-title">List your property</h1>
      <p className="form-desc">Listing as <strong>{user.firstName} {user.lastName}</strong></p>
      <div className="form-card">
        <div className="form-group"><label className="form-label">Monthly Rent <span className="required">*</span></label><input className={`form-input${errors.rent ? " error" : ""}`} type="number" placeholder="₹ 20,000" value={form.rent} onChange={set("rent")} />{errors.rent && <span className="form-error">{errors.rent}</span>}</div>
        <div className="form-group">
          <label className="form-label">Property Type <span className="required">*</span></label>
          <BhkSelector selected={form.bhk} onChange={bhk => { setForm(f => ({ ...f, bhk })); setErrors(e => ({ ...e, bhk: "" })); }} error={errors.bhk} />
        </div>
        <div className="form-group"><label className="form-label">Property Location <span className="required">*</span></label><LocationField location={form.location} onSelect={p => { setForm(f => ({ ...f, location: p })); setErrors(e => ({ ...e, location: "" })); }} onClear={() => setForm(f => ({ ...f, location: emptyLoc }))} error={errors.location} /></div>
        <div className="divider" />
        <div className="form-group"><label className="form-label">Available From <span className="required">*</span></label><input className={`form-input${errors.availFrom ? " error" : ""}`} type="date" min={getToday()} value={form.availFrom} onChange={set("availFrom")} />{errors.availFrom && <span className="form-error">{errors.availFrom}</span>}</div>
        <div className="submit-row"><button className="btn-submit" onClick={submit} disabled={loading}>{loading ? <><div className="spinner" />Listing…</> : "List Property →"}</button></div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCH CARD — reservation status from Google Sheet (sheetReservations prop)
// Visit Done always shown for owner; disabled if not reserved
// ─────────────────────────────────────────────────────────────────────────────
function MatchCard({ card, tier, cardType, user, sheetReservations = {} }) {
  const [showContact,    setShowContact]    = useState(false);
  const [showPayment,    setShowPayment]    = useState(false);
  const [localReserved,  setLocalReserved]  = useState(false);
  const [localCleared,   setLocalCleared]   = useState(false);
  const isTenant = cardType === "tenant";

  // Sheet is source of truth; local flags handle immediate UI feedback before next refresh
  const sheetRes    = sheetReservations[card.id];
  const sheetStatus = sheetRes?.status || "";
  const visitCount  = sheetRes?.visitCount || 0;
  const isReserved  = localCleared ? false : (localReserved || sheetStatus === "Reserved");

  const handlePaid = () => setLocalReserved(true);

  const handleVisitDone = async () => {
    const newCount = visitCount + 1;
    try {
      await postToSheet("Reservations", {
        "Reservation ID":    `V-${Date.now()}`,
        "Reserved At":       new Date().toLocaleString("en-IN"),
        "Tenant Name":       sheetRes?.tenantName   || "—",
        "Tenant Mobile":     sheetRes?.tenantMobile || "—",
        "Owner Name":        `${user.firstName} ${user.lastName}`,
        "Owner Mobile":      user.mobile,
        "Submission ID":     card.id,
        "Property Location": card.location,
        "Monthly Rent (₹)":  card.rent || card.budgetMin || 0,
        "Amount Paid (₹)":   "0",
        "Status":            "Visit Done",
        "Visit Count":       newCount,
      });
    } catch (_) {}
    setLocalCleared(true);
    setLocalReserved(false);
  };

  return (
    <>
      <div className={`match-card ${tier}${isReserved ? " is-reserved" : ""}`}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.4rem", marginBottom:(isReserved || visitCount > 0) ? "0.5rem" : "0" }}>
          {isReserved && <span className="reserved-tag">🔒 Reserved</span>}
          {visitCount > 0 && <span className="visit-count-badge">👁 {visitCount} {visitCount === 1 ? "visit" : "visits"}</span>}
        </div>
        {isTenant ? (
          <><div className="card-rent"><sup>₹</sup>{card.rent.toLocaleString("en-IN")}</div><div className="card-period">per month · {card.bhk}</div></>
        ) : (
          <><div className="card-budget">₹{Number(card.budgetMin).toLocaleString("en-IN")} – ₹{Number(card.budgetMax).toLocaleString("en-IN")}</div><div className="card-period">budget · {card.bhk}</div></>
        )}
        <div className="card-divider" />
        <div className="card-detail">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span>{card.location}</span>
        </div>
        <div className="card-detail">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>{isTenant ? `Available: ${card.available}` : `Move-in: ${card.moveIn}`}</span>
        </div>
        {!isTenant && card.urgency && (
          <div className="card-detail">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <span>{card.urgency}</span>
          </div>
        )}
        <div className="card-footer">
          <button className="card-btn contact" onClick={() => setShowContact(true)}>Contact</button>
          {isTenant && (
            isReserved
              ? <button className="card-btn reserved-btn">🔒 Reserved</button>
              : <button className="card-btn reserve" onClick={() => setShowPayment(true)}>Reserve Now</button>
          )}
          {/* Visit Done — always visible for owner; enabled only when reserved */}
          {!isTenant && (
            isReserved
              ? <button className="card-btn visit-done" onClick={handleVisitDone}>✓ Visit Done</button>
              : <button className="card-btn visit-done-disabled" disabled title="No active reservation">Visit Done</button>
          )}
        </div>
      </div>
      {showContact && <ContactModal name={isTenant ? card.ownerName : card.tenantName} mobile={isTenant ? card.ownerMobile : card.tenantMobile} role={isTenant ? "Owner" : "Tenant"} onClose={() => setShowContact(false)} />}
      {showPayment && <PaymentModal card={card} user={user} onClose={() => setShowPayment(false)} onPaid={handlePaid} />}
    </>
  );
}

function MatchSection({ title, cards, tier, cardType, user, sheetReservations }) {
  if (!cards.length) return null;
  return (
    <div>
      <div className="section-label">
        <div className={`section-dot ${tier}`}/><span className="section-name">{title}</span>
        <div className="section-divider"/><span className="section-count">{cards.length} {cards.length===1?"result":"results"}</span>
      </div>
      <div className="cards-grid">
        {cards.map(c => <MatchCard key={c.id} card={c} tier={tier} cardType={cardType} user={user} sheetReservations={sheetReservations||{}} />)}
      </div>
    </div>
  );
}

function MatchesPage({ matches, setPage, cardType, title, subtitle, user, sheetReservations }) {
  const total = matches.high_priority.length + matches.medium.length + matches.low.length;
  if (total === 0) return (
    <div className="matches-page"><div className="state-box">
      <div className="state-icon">🏠</div><h3>No matches yet</h3>
      <p>{cardType==="tenant"?"No listed properties match your criteria right now.":"No tenants currently match your listing."} Check back soon.</p>
      <br/><button className="btn-outline" onClick={()=>setPage("home")}>← Go home</button>
    </div></div>
  );
  return (
    <div className="matches-page">
      <div className="matches-header">
        <div><h1 className="matches-title">{title||"Your matches"}</h1><p className="matches-sub">{subtitle}</p></div>
        <div className="matches-stats">
          {matches.high_priority.length>0&&<span className="stat-chip high">● {matches.high_priority.length} High</span>}
          {matches.medium.length>0&&        <span className="stat-chip med"> ● {matches.medium.length} Medium</span>}
          {matches.low.length>0&&           <span className="stat-chip low"> ● {matches.low.length} Low</span>}
        </div>
      </div>
      <MatchSection title="High Priority" cards={matches.high_priority} tier="high" cardType={cardType} user={user} sheetReservations={sheetReservations}/>
      <MatchSection title="Medium"        cards={matches.medium}         tier="med"  cardType={cardType} user={user} sheetReservations={sheetReservations}/>
      <MatchSection title="Low"           cards={matches.low}            tier="low"  cardType={cardType} user={user} sheetReservations={sheetReservations}/>
      <div style={{textAlign:"center",marginTop:"1rem"}}><button className="btn-outline" onClick={()=>setPage("home")}>← Go home</button></div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MY LISTINGS PAGE — Tenant / Owner tab switcher
// Owner tab: listing summary + matched tenants (from sheet, with Visit Done)
// Tenant tab: last search displayed as info box + matched properties
// ─────────────────────────────────────────────────────────────────────────────
function MyListingsPage({ setPage, ownerMatches, setOwnerMatches, showToast, user, tenantMatches, setTenantMatches, sheetRes, refreshSheetRes }) {
  const [activeTab, setActiveTab] = useState("owner");
  const [loading,   setLoading]   = useState(false);
  const [resLoading,setResLoading]= useState(false);

  const listing = getOwnerListing(user.mobile);

  // On mount: fetch fresh reservations from sheet into root state
  useEffect(() => {
    setResLoading(true);
    refreshSheetRes().finally(() => setResLoading(false));
  }, []);

  // Refresh owner matches + reservations
  const refreshOwner = async () => {
    if (!listing) { showToast("No listing found — please list a property first.", "info"); return; }
    setLoading(true);
    try {
      const [tenants] = await Promise.all([fetchSheet("Tenant"), refreshSheetRes()]);
      setOwnerMatches(buildOwnerMatches(listing, tenants));
      showToast("Matches refreshed!", "success");
    } catch (err) { showToast("Refresh failed: " + err.message, "error"); }
    finally { setLoading(false); }
  };

  // Refresh tenant matches + reservations
  const refreshTenant = async () => {
    if (!lastSearch) return;
    setLoading(true);
    try {
      const entry = {
        "Budget Min (₹)": lastSearch.budgetMin, "Budget Max (₹)": lastSearch.budgetMax,
        "Move-in Date": lastSearch.moveIn, "BHK Types": (lastSearch.bhk||[]).join(", "),
        "Location": lastSearch.location?.address,
      };
      const [owners] = await Promise.all([fetchSheet("Owner"), refreshSheetRes()]);
      setTenantMatches(buildTenantMatches(entry, owners));
      showToast("Tenant matches refreshed!", "success");
    } catch (err) { showToast("Refresh failed: " + err.message, "error"); }
    finally { setLoading(false); }
  };

  // Get last tenant search from saved searches
  const savedSearches = getSavedSearches(user.mobile);
  const lastSearch    = savedSearches[0] || null;

  // Get last tenant search from saved searches (this user only)
  const savedSearches = getSavedSearches(user.mobile);
  const lastSearch    = savedSearches[0] || null;

  const ownerTotal  = (ownerMatches.high_priority?.length||0) + (ownerMatches.medium?.length||0) + (ownerMatches.low?.length||0);
  const tenantTotal = (tenantMatches?.high_priority?.length||0) + (tenantMatches?.medium?.length||0) + (tenantMatches?.low?.length||0);

  return (
    <div className="matches-page">
      {/* Page header */}
      <div className="matches-header">
        <div>
          <h1 className="matches-title">My Listings &amp; Matches</h1>
          <p className="matches-sub">{user.firstName}'s dashboard</p>
        </div>
        <button className="refresh-btn"
          onClick={activeTab === "owner" ? refreshOwner : refreshTenant}
          disabled={loading}>
          {loading
            ? <><div className="spinner-dark" style={{width:"12px",height:"12px"}}/>Refreshing…</>
            : "⟳ Refresh"}
        </button>
      </div>

      {/* Tab switcher */}
      <div className="my-listings-tabs">
        <button className={`my-listings-tab${activeTab==="owner"  ? " active" : ""}`} onClick={() => setActiveTab("owner")}>🏠 My Property Listing</button>
        <button className={`my-listings-tab${activeTab==="tenant" ? " active" : ""}`} onClick={() => setActiveTab("tenant")}>🔍 My Property Search</button>
      </div>

      {/* ── OWNER TAB ── */}
      {activeTab === "owner" && (
        !listing ? (
          <div className="state-box">
            <div className="state-icon">🏠</div><h3>No active listing</h3><p>You haven't listed a property yet.</p>
            <br/><button className="btn-primary" onClick={() => setPage("owner")}>List a Property</button>
          </div>
        ) : (
          <>
            <div className="listing-summary">
              <div className="listing-label">Your Active Listing</div>
              <div className="listing-rent">₹{Number(listing["Monthly Rent (₹)"]).toLocaleString("en-IN")}<span style={{fontFamily:"'DM Sans',sans-serif",fontSize:"0.8rem",color:"#8A7A6A"}}>/mo</span></div>
              <div className="listing-meta">🏠 {listing["BHK Types"]} · 📍 {listing["Location"]}</div>
              <div className="listing-meta">🗓 Available from {listing["Available From"]}</div>
            </div>
            {resLoading && <div style={{textAlign:"center",padding:"1rem",fontSize:"0.82rem",color:"#8A7A6A"}}>⏳ Loading reservation status…</div>}
            {ownerTotal === 0 ? (
              <div className="state-box" style={{padding:"2rem"}}>
                <div className="state-icon">👥</div><h3>No matching tenants yet</h3><p>Click Refresh to check for new matches.</p>
              </div>
            ) : (
              <>
                <div className="matches-stats" style={{marginBottom:"1.5rem"}}>
                  {ownerMatches.high_priority.length>0&&<span className="stat-chip high">● {ownerMatches.high_priority.length} High</span>}
                  {ownerMatches.medium.length>0&&        <span className="stat-chip med"> ● {ownerMatches.medium.length} Medium</span>}
                  {ownerMatches.low.length>0&&           <span className="stat-chip low"> ● {ownerMatches.low.length} Low</span>}
                </div>
                <MatchSection title="High Priority Tenants" cards={ownerMatches.high_priority} tier="high" cardType="owner" user={user} sheetReservations={sheetRes}/>
                <MatchSection title="Medium Matches"        cards={ownerMatches.medium}         tier="med"  cardType="owner" user={user} sheetReservations={sheetRes}/>
                <MatchSection title="Low Matches"           cards={ownerMatches.low}            tier="low"  cardType="owner" user={user} sheetReservations={sheetRes}/>
              </>
            )}
          </>
        )
      )}

      {/* ── TENANT TAB ── */}
      {activeTab === "tenant" && (
        !lastSearch ? (
          <div className="state-box">
            <div className="state-icon">🔍</div><h3>No saved search yet</h3><p>Go to the Tenant form to search for properties.</p>
            <br/><button className="btn-primary" onClick={() => setPage("tenant")}>Search Properties</button>
          </div>
        ) : (
          <>
            {/* Search details info box — read-only summary */}
            <div className="search-info-box">
              <div className="search-info-label">
                Your Last Search
                <button onClick={() => setPage("tenant")}>✏ Edit Search</button>
              </div>
              <div className="search-info-grid">
                <div className="search-info-item">
                  <div className="search-info-key">Budget</div>
                  <div className="search-info-val">₹{Number(lastSearch.budgetMin).toLocaleString("en-IN")} – ₹{Number(lastSearch.budgetMax).toLocaleString("en-IN")}</div>
                </div>
                <div className="search-info-item">
                  <div className="search-info-key">BHK Type</div>
                  <div className="search-info-val">{(lastSearch.bhk||[]).join(", ") || "—"}</div>
                </div>
                <div className="search-info-item">
                  <div className="search-info-key">Move-in Date</div>
                  <div className="search-info-val">{lastSearch.moveIn || "—"}</div>
                </div>
                <div className="search-info-item">
                  <div className="search-info-key">Urgency</div>
                  <div className="search-info-val">{lastSearch.urgency || "—"}</div>
                </div>
                <div className="search-info-item search-info-full">
                  <div className="search-info-key">Location</div>
                  <div className="search-info-val">{lastSearch.location?.address || "—"}</div>
                </div>
                <div className="search-info-item">
                  <div className="search-info-key">Saved At</div>
                  <div className="search-info-val" style={{fontSize:"0.75rem",color:"#8A7A6A"}}>{lastSearch.savedAt}</div>
                </div>
              </div>
            </div>

            {tenantTotal === 0 ? (
              <div className="state-box" style={{padding:"2rem"}}>
                <div className="state-icon">🏠</div><h3>No matching properties</h3>
                <p>No owner listings match your criteria yet. Click Refresh to check again or edit your search.</p>
              </div>
            ) : (
              <>
                <div className="matches-stats" style={{marginBottom:"1.5rem"}}>
                  {tenantMatches.high_priority.length>0&&<span className="stat-chip high">● {tenantMatches.high_priority.length} High</span>}
                  {tenantMatches.medium.length>0&&        <span className="stat-chip med"> ● {tenantMatches.medium.length} Medium</span>}
                  {tenantMatches.low.length>0&&           <span className="stat-chip low"> ● {tenantMatches.low.length} Low</span>}
                </div>
                <MatchSection title="High Priority Properties" cards={tenantMatches.high_priority} tier="high" cardType="tenant" user={user} sheetReservations={sheetRes}/>
                <MatchSection title="Medium Matches"           cards={tenantMatches.medium}         tier="med"  cardType="tenant" user={user} sheetReservations={sheetRes}/>
                <MatchSection title="Low Matches"              cards={tenantMatches.low}            tier="low"  cardType="tenant" user={user} sheetReservations={sheetRes}/>
              </>
            )}
          </>
        )
      )}

      <div style={{textAlign:"center",marginTop:"1.5rem"}}>
        <button className="btn-outline" onClick={() => setPage("home")}>← Go home</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [page,          setPage]          = useState("landing");
  const [user,          setUser]          = useState(getSession);
  const [role,          setRole]          = useState(getRole);
  const [matches,       setMatches]       = useState({ high_priority: [], medium: [], low: [] });
  const [ownerMatches,  setOwnerMatches]  = useState({ high_priority: [], medium: [], low: [] });
  const [sheetRes,      setSheetRes]      = useState({});  // global reservation map — source of truth
  const [toast,         setToast]         = useState(null);

  const showToast = (msg, type = "info") => setToast({ message: msg, type });

  useEffect(() => { if (user) setPage("home"); }, []);

  // Build reservation map from raw Reservations sheet rows
  // Latest row per Submission ID wins (handles Reserved → Visit Done sequence)
  const buildResMap = (rows) => {
    const map = {};
    rows.forEach(r => {
      const id     = String(r["Submission ID"] || "");
      const ts     = String(r["Reserved At"]   || "");
      const status = String(r["Status"]        || "");
      const count  = Number(r["Visit Count"]   || 0);
      if (!id) return;
      // If current status is "Visit Done" it should always win regardless of timestamp
      // because it means the property is now available again
      const existing = map[id];
      if (!existing) {
        map[id] = { status, visitCount: count, tenantName: String(r["Tenant Name"]||""), tenantMobile: String(r["Tenant Mobile"]||""), ts };
      } else {
        // Visit Done always wins; otherwise latest timestamp wins
        if (status === "Visit Done" || (!existing.status.includes("Visit Done") && ts >= existing.ts)) {
          map[id] = { status, visitCount: Math.max(count, existing.visitCount), tenantName: String(r["Tenant Name"]||""), tenantMobile: String(r["Tenant Mobile"]||""), ts };
        }
      }
    });
    return map;
  };

  const refreshSheetRes = async () => {
    try {
      const rows = await fetchSheet("Reservations");
      setSheetRes(buildResMap(rows));
    } catch (_) {}
  };

  // After tenant submits and gets matches, fetch fresh reservation map
  const handleSetMatches = async (m) => {
    setMatches(m);
    await refreshSheetRes();
  };

  const handleRoleChange = r => { setRole(r); localStorage.setItem("nm_role", r); };
  const handleNavRole    = r => { handleRoleChange(r); setPage(r); };
  const handleLogin      = profile => { setUser(profile); setSession(profile); setPage("home"); };
  const handleLogout     = () => { clearSession(); setUser(null); setPage("landing"); showToast("Logged out.", "info"); };

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <Navbar page={page} setPage={setPage} user={user} role={role} setRole={handleNavRole} onLogout={handleLogout} onMyListings={() => setPage("my-listings")} />

        {!user && page === "landing"       && <LandingPage setPage={setPage} />}
        {!user && page === "signup"        && <SignupPage  setPage={setPage} showToast={showToast} />}
        {!user && page === "login"         && <LoginPage   setPage={setPage} onLogin={handleLogin} showToast={showToast} />}

        {user  && page === "home"          && <HomePage     setPage={setPage} user={user} role={role} setRole={handleRoleChange} />}
        {user  && page === "tenant"        && <TenantForm   setPage={setPage} setMatches={handleSetMatches} showToast={showToast} user={user} />}
        {user  && page === "owner"         && <OwnerForm    setPage={setPage} showToast={showToast} user={user} setOwnerMatches={setOwnerMatches} />}
        {user  && page === "matches"       && <MatchesPage  matches={matches} setPage={setPage} cardType="tenant" title="Your Matches" subtitle={`${matches.high_priority.length+matches.medium.length+matches.low.length} properties from live listings`} user={user} sheetReservations={sheetRes} />}
        {user  && page === "owner-matches" && <MatchesPage  matches={ownerMatches} setPage={setPage} cardType="owner" title="Matching Tenants" subtitle="Tenants whose budget and BHK type match your listing" user={user} sheetReservations={sheetRes} />}
        {user  && page === "my-listings"   && <MyListingsPage setPage={setPage} ownerMatches={ownerMatches} setOwnerMatches={setOwnerMatches} showToast={showToast} user={user} tenantMatches={matches} setTenantMatches={setMatches} sheetRes={sheetRes} refreshSheetRes={refreshSheetRes} />}

        {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}
      </div>
    </>
  );
}
