const STORAGE_KEY = "nestmatch_data";

export function loadStoredData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { tenants: [], owners: [] };
  } catch { return { tenants: [], owners: [] }; }
}

export function saveStoredData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function addTenant(entry) {
  const data = loadStoredData();
  data.tenants.push(entry);
  saveStoredData(data);
  return data;
}

export function addOwner(entry) {
  const data = loadStoredData();
  data.owners.push(entry);
  saveStoredData(data);
  return data;
}
