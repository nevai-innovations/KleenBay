/* KleenBay — car wash operations prototype.
   Sample data only; everything lives in this tab and resets on reload. */
'use strict';

const BUSINESS = 'Sparkle Car Wash';
// Signed-in user for this browser tab. Prototype: sessionStorage. Real app: server-issued session.
let session = null;
const me = () => session?.name ?? '';
const isOwner = () => session?.role === 'OWNER';
const OWNER = { id: 'owner', name: 'Suresh', phone: '9847012000', role: 'OWNER' };
const MIN = 60000;

let SERVICES = [
  { id: 'basic', name: 'Basic Wash', price: 299, mins: 30, active: true },
  { id: 'premium', name: 'Premium Wash', price: 599, mins: 45, active: true },
  { id: 'exterior', name: 'Exterior Wash', price: 199, mins: 20, active: true },
  { id: 'interior', name: 'Interior Cleaning', price: 499, mins: 40, active: true },
  { id: 'detail', name: 'Full Detailing', price: 2499, mins: 180, active: true },
];

const FLOW = ['RECEIVED', 'WASH_STARTED', 'WASHING', 'WASH_COMPLETE', 'READY_FOR_DELIVERY', 'DELIVERED'];
const ACTIVE = FLOW.slice(0, 5);
// Stage colours are theme tokens (--st-0..4); green only means "ready to hand over".
const STAGE = {
  RECEIVED: { col: 'Received', label: 'Received', short: 'Received', action: 'Start wash', tone: 'var(--st-0)', group: 'WAITING' },
  WASH_STARTED: { col: 'Started', label: 'Wash started', short: 'Started', action: 'Now washing', tone: 'var(--st-1)', group: 'WASHING' },
  WASHING: { col: 'Washing', label: 'Washing', short: 'Washing', action: 'Wash done', tone: 'var(--st-2)', group: 'WASHING' },
  WASH_COMPLETE: { col: 'Washed', label: 'Wash complete', short: 'Done', action: 'Mark ready', tone: 'var(--st-3)', group: 'WASHING' },
  READY_FOR_DELIVERY: { col: 'Ready', label: 'Ready for pickup', short: 'Ready', action: 'Hand over', tone: 'var(--st-4)', group: 'READY' },
  DELIVERED: { col: 'Delivered', label: 'Delivered', short: 'Delivered', action: null, tone: 'var(--st-0)', group: 'DONE' },
};
const GROUPS = [
  { id: 'WAITING', label: 'Waiting', stages: ['RECEIVED'] },
  { id: 'WASHING', label: 'Washing', stages: ['WASH_STARTED', 'WASHING', 'WASH_COMPLETE'] },
  { id: 'READY', label: 'Ready', stages: ['READY_FOR_DELIVERY'] },
];
const NOTIFY = {
  RECEIVED: { event: 'Vehicle received', text: (j) => `Hi ${j.customer}, your vehicle ${fmtPlate(j.plate)} has been received at ${BUSINESS}. We will keep you updated.` },
  WASH_STARTED: { event: 'Wash started', text: (j) => `Hi ${j.customer}, washing has started for ${fmtPlate(j.plate)} at ${BUSINESS}.` },
  READY_FOR_DELIVERY: { event: 'Ready for pickup', text: (j) => `Hi ${j.customer}, your vehicle ${fmtPlate(j.plate)} is ready for pickup at ${BUSINESS}. Thank you.` },
};
const PAY = [
  { v: 'CASH', name: 'Cash' },
  { v: 'UPI', name: 'UPI' },
  { v: 'CARD', name: 'Card' },
  { v: 'UNPAID', name: 'Pay later' },
];
const ETA = [{ v: 'svc', l: 'Service time' }, { v: '30', l: '+30 min' }, { v: '60', l: '+1 hr' }, { v: '120', l: '+2 hr' }, { v: 'none', l: 'Not set' }];
const CONTACTS = [
  { id: 'owner', name: 'Suresh (Owner)', phone: '9847012000' },
  { id: 'manager', name: 'Deepa (Manager)', phone: '9847012001' },
];
const MAX_PHOTOS = 10;
const MAX_UPLOAD = 20 * 1024 * 1024;
const DELETE_WINDOW = 10 * MIN;

/* ---------------------------------------------------------------- helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svc = (id) => SERVICES.find((s) => s.id === id) || { id, name: 'Removed wash type', price: 0, mins: 30, active: false };
// price is fixed when the car is checked in, so later price changes never rewrite history
const jobPrice = (j) => j.price ?? svc(j.service).price;
const byId = (id) => jobs.find((j) => j.id === id);
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const payName = (v) => PAY.find((p) => p.v === v)?.name ?? v;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const carName = (j) => [j.make, j.model].filter(Boolean).join(' ');

const normPlate = (v) => String(v || '').toUpperCase().replace(/[\s.\-/]/g, '');
function fmtPlate(p) {
  let m = p.match(/^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/);
  if (m) return m.slice(1).join(' ');
  m = p.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? m.slice(1).filter(Boolean).join(' ') : p;
}
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
const fmtPhone = (d) => `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
function fmtTime(t) {
  const d = new Date(t), h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 1) return 'just now';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const fmtMins = (m) => (m < 60 ? `${m} min` : `${m / 60} hr`);
const roundUp5 = (t) => Math.ceil(t / (5 * MIN)) * 5 * MIN;
const hourLabel = (h) => `${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}`;
const fmtDay = (t) => new Date(t).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const isLate = (j) => !!j.expectedAt && !['READY_FOR_DELIVERY', 'DELIVERED'].includes(j.status) && Date.now() > j.expectedAt;
const readPref = (k) => { try { return localStorage.getItem('lustre:' + k); } catch { return null; } };
const writePref = (k, v) => { try { localStorage.setItem('lustre:' + k, v); } catch { /* private mode */ } };

const ICON = {
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-3.6-6.7L20 4l-1.2 3.4A7.9 7.9 0 0 1 20 12Z"/><path d="M9 11h6M9 14.5h4"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h3l1.5-2h7L17 8.5h3v10H4z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

/* ---------------------------------------------------------------- data */
let seq = 140, photoSeq = 0;
let jobs = [];
let staff = [];
const pastVisits = { KL29AB1234: 3, KL07BB5050: 3, KL08D3131: 5, KL44H1212: 2 };
const pastVehicles = [{ plate: 'KL07BB5050', make: 'Maruti Suzuki', model: 'Ertiga', customer: 'Sreeja', phone: '9847000111', service: 'basic' }];

function samplePhoto(plate, kind, variant) {
  const dirty = kind === 'BEFORE';
  const sky = dirty ? ['#3b3a35', '#22211d'] : ['#10525b', '#06272f'];
  const body = ['#8f2f2f', '#2b3550', '#b9bfc9', '#1d3f7a'][variant % 4];
  const marks = dirty
    ? Array.from({ length: 12 }, (_, i) => `<circle cx="${170 + ((i * 97) % 470)}" cy="${280 + ((i * 53) % 120)}" r="${5 + ((i * 7) % 12)}" fill="#6b5a3a" opacity=".7"/>`).join('')
    : Array.from({ length: 5 }, (_, i) => `<path d="M${210 + i * 90} ${205 + (i % 2) * 36} l5 14 14 5 -14 5 -5 14 -5 -14 -14 -5 14 -5z" fill="#eaf7ff" opacity=".9"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><rect y="440" width="800" height="160" fill="#101318"/><path d="M120 410 L170 310 Q190 270 240 265 L520 260 Q580 260 620 310 L690 350 Q720 360 720 400 L720 430 L120 430 Z" fill="${body}"/><path d="M250 280 L500 275 Q550 276 580 320 L220 325 Z" fill="#cfe6ff" opacity=".8"/><circle cx="250" cy="435" r="46" fill="#07090c"/><circle cx="250" cy="435" r="18" fill="#5b6472"/><circle cx="590" cy="435" r="46" fill="#07090c"/><circle cx="590" cy="435" r="18" fill="#5b6472"/>${marks}<text x="28" y="56" font-family="monospace" font-size="26" fill="#e9eef7" opacity=".9">${dirty ? 'BEFORE' : 'AFTER'}</text><text x="28" y="576" font-family="monospace" font-size="24" fill="#e9eef7" opacity=".75">${plate}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function seed(o) {
  const t0 = Date.now();
  const crew = o.staff || ['Salim', 'Ravi'];
  const history = o.ago.map((a, i) => ({ kind: i === 0 ? 'CREATE' : 'ADVANCE', from: i === 0 ? null : FLOW[i - 1], to: FLOW[i], at: t0 - a * MIN, by: crew[i % crew.length] }));
  const last = history.at(-1);
  const job = {
    id: 'j' + ++seq, number: seq, plate: o.plate, make: o.make, model: o.model, customer: o.customer, phone: o.phone,
    service: o.service, price: svc(o.service).price, status: last.to, receivedAt: history[0].at, stageAt: last.at, createdBy: history[0].by,
    expectedAt: o.due == null ? null : roundUp5(t0 + o.due * MIN), notes: o.notes || '', notify: true,
    history, msgs: [], photos: [], deliveredAt: last.to === 'DELIVERED' ? last.at : null,
    payment: last.to === 'DELIVERED' ? { method: o.pay || 'CASH', amount: svc(o.service).price, at: last.at, by: last.by } : null,
  };
  const at = { BEFORE: history[0].at + MIN, AFTER: (history[3] || last).at + MIN };
  for (const kind of ['BEFORE', 'AFTER']) {
    for (let i = 0; i < ((o.photos || {})[kind] || 0); i++) {
      job.photos.push({ id: 'p' + ++photoSeq, kind, url: samplePhoto(fmtPlate(o.plate), kind, seq + i), at: at[kind] + i * 20000, by: history[0].by, sample: true });
    }
  }
  history.forEach((h) => { if (NOTIFY[h.to]) job.msgs.push(makeMsg(job, h.to, h.at, 'Sent')); });
  jobs.push(job);
}
function makeMsg(job, status, at, state) {
  return {
    key: status, event: NOTIFY[status].event, to: fmtPhone(job.phone), text: NOTIFY[status].text(job),
    state, at, sentAt: state === 'Sent' ? at + 3000 : null,
    photo: status === 'READY_FOR_DELIVERY' && (job.photos || []).some((p) => p.kind === 'AFTER'),
  };
}

function seedDemo() {
  const day = 86400000;
  staff = [
    { id: 'st-ravi', name: 'Ravi', phone: '9847020001', active: true, addedAt: Date.now() - 40 * day, lastLoginAt: null },
    { id: 'st-salim', name: 'Salim', phone: '9847020002', active: true, addedAt: Date.now() - 90 * day, lastLoginAt: null },
    { id: 'st-anu', name: 'Anu', phone: '9847020003', active: true, addedAt: Date.now() - 12 * day, lastLoginAt: null },
  ];
  seed({ plate: 'KL29AB1234', make: 'Hyundai', model: 'Creta', customer: 'Arun', phone: '9847000001', service: 'premium', ago: [6], due: 84 });
  seed({ plate: 'KL07CD4521', make: 'Maruti Suzuki', model: 'Swift', customer: 'Meera', phone: '9847000002', service: 'basic', ago: [2], due: 40 });
  seed({ plate: 'KL11BK9087', make: 'Toyota', model: 'Innova Crysta', customer: 'Joseph', phone: '9847000003', service: 'detail', ago: [20, 4], due: 170, notes: 'Pet hair on rear seats', photos: { BEFORE: 2 } });
  seed({ plate: 'KL01AZ3300', make: 'Honda', model: 'City', customer: 'Fathima', phone: '9847000004', service: 'exterior', ago: [48, 30, 27], due: -6 });
  seed({ plate: 'KL39F7788', make: 'Tata', model: 'Nexon', customer: 'Rahul', phone: '9847000005', service: 'interior', ago: [31, 16, 14], due: 25 });
  seed({ plate: 'KL05AQ2210', make: 'Kia', model: 'Seltos', customer: 'Anjali', phone: '9847000006', service: 'premium', ago: [58, 50, 47, 3], due: 12, photos: { BEFORE: 2, AFTER: 1 } });
  seed({ plate: 'KL63C1001', make: 'Mahindra', model: 'XUV700', customer: 'Vishnu', phone: '9847000007', service: 'basic', ago: [75, 66, 63, 40, 18], due: -20, photos: { BEFORE: 1, AFTER: 2 } });
  seed({ plate: '22BH4455AA', make: 'Maruti Suzuki', model: 'Baleno', customer: 'Nikhil', phone: '9847000008', service: 'premium', ago: [64, 55, 52, 9, 3], due: 10 });
  seed({ plate: 'KL07EF6006', make: 'Hyundai', model: 'i20', customer: 'Lakshmi', phone: '9847000009', service: 'basic', ago: [190, 182, 180, 150, 145, 120], due: null, pay: 'UPI', photos: { BEFORE: 1, AFTER: 1 } });
  seed({ plate: 'KL45G2020', make: 'Skoda', model: 'Kushaq', customer: 'Arun', phone: '9847000001', service: 'interior', ago: [260, 250, 247, 212, 205, 170], due: null, pay: 'CASH' });
  seed({ plate: 'KL08D3131', make: 'Maruti Suzuki', model: 'Alto', customer: 'Deepak', phone: '9847000010', service: 'basic', ago: [300, 292, 290, 265, 262, 240], due: null, pay: 'CASH', staff: ['Anu', 'Ravi'] });
  seed({ plate: 'KL10P7272', make: 'Toyota', model: 'Glanza', customer: 'Sneha', phone: '9847000011', service: 'premium', ago: [285, 280, 277, 236, 230, 226], due: null, pay: 'UPI', staff: ['Salim', 'Anu'] });
  seed({ plate: 'KL02T5656', make: 'Hyundai', model: 'Venue', customer: 'Ajay', phone: '9847000012', service: 'exterior', ago: [240, 236, 234, 215, 212, 200], due: -220, pay: 'UPI', staff: ['Anu'] });
  seed({ plate: 'KL35M8989', make: 'MG', model: 'Hector', customer: 'Farhan', phone: '9847000013', service: 'detail', ago: [330, 320, 316, 150, 140, 110], due: -130, pay: 'CARD', staff: ['Ravi', 'Salim', 'Anu'] });
  seed({ plate: 'KL13K4545', make: 'Renault', model: 'Kwid', customer: 'Priya', phone: '9847000014', service: 'basic', ago: [150, 144, 142, 120, 110, 95], due: null, pay: 'UNPAID', staff: ['Anu', 'Salim'] });
  seed({ plate: 'KL44H1212', make: 'Honda', model: 'Amaze', customer: 'Vinod', phone: '9847000015', service: 'interior', ago: [210, 200, 197, 160, 150, 130], due: -170, pay: 'CASH', staff: ['Ravi', 'Anu'] });
}

const visits = (plate) => (pastVisits[plate] || 0) + jobs.filter((j) => j.plate === plate).length;
function findVehicle(plate) {
  const j = jobs.filter((x) => x.plate === plate).sort((a, b) => b.receivedAt - a.receivedAt)[0];
  if (j) return { ...j, active: j.status !== 'DELIVERED' ? j : null };
  return pastVehicles.find((v) => v.plate === plate) || null;
}
const findCustomer = (phone) => jobs.filter((x) => x.phone === phone).sort((a, b) => b.receivedAt - a.receivedAt)[0] || pastVehicles.find((v) => v.phone === phone) || null;

/* ---------------------------------------------------------------- app state */
const view = $('#view');
const ui = { group: 'ALL', query: '', flash: null, focusNew: null };
const report = {
  closeTime: readPref('close-time') || '21:00',
  recipients: new Set((readPref('recipients') || 'owner').split(',').filter(Boolean)),
  sent: [], closedAt: null,
};

/* ---------------------------------------------------------------- persistence
   Prototype only: shared data sits in this browser's localStorage, so an owner tab and an
   employee tab see each other's changes live. The real app keeps all of this on the server. */
const STORE = 'lustre:db:v2';
let lastSaved = '';
const snapshot = () => JSON.stringify({ v: 2, seq, photoSeq, jobs, services: SERVICES, staff, sent: report.sent, closedAt: report.closedAt });
function applySnapshot(raw) {
  const d = JSON.parse(raw);
  ({ seq, photoSeq, jobs, staff } = d);
  SERVICES = d.services;
  report.sent = d.sent;
  report.closedAt = d.closedAt;
  lastSaved = raw;
}
function saveDb() {
  const raw = snapshot();
  if (raw === lastSaved) return;
  try { localStorage.setItem(STORE, raw); lastSaved = raw; }
  catch { toast('Could not save', 'Browser storage is full. Delete some photos or reset the demo data.'); }
}
(function loadDb() {
  let raw = null;
  try { raw = localStorage.getItem(STORE); } catch { /* storage blocked: run in memory */ }
  if (raw) { try { applySnapshot(raw); return; } catch { /* unreadable: start fresh */ } }
  seedDemo();
  saveDb();
})();

/* ---------------------------------------------------------------- sessions */
const SESSION_KEY = 'lustre:session';
function validSession(u) {
  if (!u) return false;
  if (u.role === 'OWNER') return u.phone === OWNER.phone;
  const st = staff.find((x) => x.id === u.id);
  return !!st && st.active;
}
function signIn(user) {
  session = { id: user.id, name: user.name, phone: user.phone, role: user.role || 'EMPLOYEE' };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* memory only */ }
  const st = staff.find((x) => x.id === user.id);
  if (st) { st.lastLoginAt = Date.now(); saveDb(); }
  // first sign-in on this device: only count updates from now on as new
  if (!readPref('activity-seen-' + session.id)) writePref('activity-seen-' + session.id, String(Date.now()));
  login = { step: 'phone', phone: '', code: '', user: null, tries: 0, err: '' };
  location.hash = '#/board';
  render();
  toast(`Welcome, ${session.name}`, isOwner() ? 'Owner portal' : 'Employee portal');
}
function signOut(reason) {
  session = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  closeSheet(); closeLightbox();
  history.replaceState(null, '', location.pathname + location.search);
  render();
  if (reason) toast(reason);
}
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
if (!validSession(session)) session = null;
let undoState = null, toastTimer = null, lb = null, draftPhotos = [];

function setTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $('meta[name="theme-color"]').content = mode === 'dark' ? '#1b1d20' : '#3d9df3';
  writePref('theme-sky', mode);
}
setTheme(readPref('theme-sky') || 'light'); // sky is the default look; charcoal is one tap away

// the top bar turns frosted once content scrolls under it
addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', scrollY > 8), { passive: true });

/* ---------------------------------------------------------------- routing */
const ROUTES = ['track', 'board', 'stage', 'new', 'job', 'summary', 'history', 'find', 'activity', 'team', 'services', 'more'];
const OWNER_ONLY = ['summary', 'history', 'team', 'services'];
function route() {
  const m = (location.hash || '#/board').match(/^#\/(\w+)(?:\/(.+))?/);
  const name = m && ROUTES.includes(m[1]) ? m[1] : 'board';
  return { name, id: m && m[2] };
}
const TITLES = {
  board: ['Board', 'Live jobs'], new: ['Check in', 'New vehicle'], summary: ['Daily summary', 'Today'],
  history: ['History', 'Delivered today'], find: ['Find a car', 'Search by number'], activity: ['Activity', 'Updates from your team'],
  team: ['Team', 'Who can sign in'], services: ['Wash types', 'What you offer and charge'], more: ['More', ''], job: ['Job', 'Vehicle detail'], stage: ['Stage', ''],
};

/* ---------------------------------------------------------------- customer tracking page
   A public link the customer opens on their own phone: no sign-in, no app.
   Live while the data is in this browser; a link opened elsewhere carries a snapshot
   in the URL instead (the real app will serve this from the server). */
const LOYALTY = { target: 6, reward: 'a free Basic Wash' };
const CUSTOMER_STEPS = ['RECEIVED', 'WASH_STARTED', 'WASHING', 'WASH_COMPLETE', 'READY_FOR_DELIVERY'];

const b64 = {
  to: (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  from: (str) => JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))))
};
// Visits for the stamp card: this vehicle's past washes at this centre.
const stampCount = (plate) => visits(plate);
function trackSnapshot(j) {
  return {
    p: j.plate, c: carName(j), n: j.customer, s: svc(j.service).name, pr: jobPrice(j),
    st: j.status, r: j.receivedAt, e: j.expectedAt, sa: j.stageAt, v: stampCount(j.plate), b: BUSINESS, ph: OWNER.phone,
  };
}
function trackUrl(j) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#/track/${j.id}~${b64.to(trackSnapshot(j))}`;
}
function trackData(key) {
  const [id, snap] = String(key).split('~');
  const j = byId(id);
  if (j) return { live: true, j, d: trackSnapshot(j), photos: j.photos };
  if (!snap) return null;
  try { return { live: false, j: null, d: b64.from(snap), photos: [] }; } catch { return null; }
}

function paintTrack(key) {
  // nothing from the staff app belongs on a customer's screen
  $('#toast').hidden = true;
  $('#sheet').innerHTML = '';
  $('#tray').hidden = true;
  $('#lightbox').innerHTML = '';
  const data = trackData(key);
  document.title = `${data ? fmtPlate(data.d.p) : 'Vehicle'} — ${BUSINESS}`;
  if (!data) {
    $('#auth').innerHTML = `<div class="track"><div class="track-card"><h1>Link not found</h1>
      <p class="muted">Ask the car wash to send the link again.</p></div></div>`;
    return;
  }
  const d = data.d;
  const now = Date.now();
  const done = CUSTOMER_STEPS.indexOf(d.st) >= 0 ? CUSTOMER_STEPS.indexOf(d.st) : CUSTOMER_STEPS.length;
  const ready = d.st === 'READY_FOR_DELIVERY';
  const delivered = d.st === 'DELIVERED';
  const steps = CUSTOMER_STEPS.map((st, i) => {
    const state = delivered || i < done ? 'done' : i === done ? 'now' : '';
    const label = { RECEIVED: 'Received', WASH_STARTED: 'Wash started', WASHING: 'Washing', WASH_COMPLETE: 'Wash complete', READY_FOR_DELIVERY: 'Ready for pickup' }[st];
    return `<li class="${state}" style="--stage:${STAGE[st].tone}"><span class="pin"></span><span>${label}</span></li>`;
  }).join('');
  const before = data.photos.filter((p) => p.kind === 'BEFORE');
  const after = data.photos.filter((p) => p.kind === 'AFTER');
  const shots = (list, title) => list.length ? `<div><h3>${title}</h3><div class="track-shots">${list.map((p) =>
    `<img src="${p.url}" alt="${title} photo" loading="lazy">`).join('')}</div></div>` : '';
  // a full card means the next wash is free; after claiming it the count starts again
  const filled = d.v > 0 && d.v % LOYALTY.target === 0 ? LOYALTY.target : d.v % LOYALTY.target;
  const left = LOYALTY.target - filled;
  const stamps = Array.from({ length: LOYALTY.target }, (_, i) => `<span class="stamp${i < filled ? ' on' : ''}"></span>`).join('');
  const bookText = `Hi ${d.b}, I would like to book a wash.%0AVehicle: ${fmtPlate(d.p)}${d.c ? ` (${d.c})` : ''}%0AService: ${d.s}%0AWhen: `;
  const status = delivered ? 'Handed over — thank you!' : ready ? 'Your vehicle is ready for pickup' : 'Your vehicle is being washed';

  $('#auth').innerHTML = `<div class="track">
    <header class="track-top">
      <span class="mark-glyph" aria-hidden="true">${GLYPH}</span>
      <div><b>${esc(d.b)}</b><small>Live wash status</small></div>
    </header>

    <section class="track-card hero-card ${ready ? 'is-ready' : ''}">
      <p class="track-status">${status}</p>
      <div class="plate">${esc(fmtPlate(d.p))}</div>
      <p class="muted">${esc(d.c || 'Vehicle')} · ${esc(d.s)}</p>
      ${!delivered && !ready && d.e ? `<p class="track-eta">Ready by about <b>${fmtTime(d.e)}</b></p>` : ''}
      ${ready ? '<p class="track-eta ok">Please collect at the counter</p>' : ''}
      <ol class="track-steps">${steps}</ol>
      ${data.live ? `<p class="dim track-live">Updated ${fmtAge(now - d.sa)} ago</p>` : '<p class="dim track-live">Snapshot from when this link was sent</p>'}
    </section>

    ${before.length || after.length ? `<section class="track-card"><h2>Photos of your vehicle</h2>
      <div class="track-photo-cols">${shots(before, 'Before')}${shots(after, 'After')}</div></section>` : ''}

    <section class="track-card">
      <h2>Your wash card</h2>
      <div class="stamp-row">${stamps}</div>
      <p class="muted">${left === 0 ? `Card full — your next wash is ${LOYALTY.reward}.` : `${d.v} wash${d.v === 1 ? '' : 'es'} so far · ${left} more for ${LOYALTY.reward}.`}</p>
    </section>

    <section class="track-card">
      <h2>Bill</h2>
      <div class="track-bill"><span>${esc(d.s)}</span><b class="mono">${inr(d.pr)}</b></div>
      <p class="dim">Pay at the counter by cash, UPI or card.</p>
    </section>

    <div class="track-actions">
      <a class="btn primary lg block" href="https://wa.me/91${d.ph}?text=${bookText}" target="_blank" rel="noopener noreferrer">Book next wash on WhatsApp</a>
      <a class="btn lg block" href="tel:+91${d.ph}">Call the car wash</a>
    </div>
    <p class="track-foot">Powered by KleenBay · no app needed</p>
  </div>`;
}

function render() {
  saveDb(); // any change made before a screen change must reach the other portals
  const pub = route();
  if (pub.name === 'track') { document.body.classList.remove('authed'); return paintTrack(pub.id); }
  document.body.classList.toggle('authed', !!session);
  if (!session) { $('#auth').innerHTML = ''; paintLogin(); return; }
  $('#auth').innerHTML = '';
  const { name, id } = route();
  if (!isOwner() && OWNER_ONLY.includes(name)) { location.hash = '#/board'; toast('Owner only', 'Ask the owner for this information'); return; }
  closeSheet(); closeLightbox();
  paintNav(name);
  const [title, meta] = TITLES[name];
  $('#viewTitle').textContent = title;
  $('#viewMeta').textContent = name === 'more' ? `${session.name} · ${isOwner() ? 'Owner' : 'Employee'}` : meta;
  const painters = { stage: () => paintStage(id), board: paintBoard, new: paintNew, summary: paintSummary, history: paintHistory, find: paintFind, activity: paintActivity, team: paintTeam, services: paintServices, more: paintMore, job: () => paintJob(id) };
  painters[name]();
  view.classList.remove('view-in');
  void view.offsetWidth;
  view.classList.add('view-in', 'intro');
  clearTimeout(render.introTimer);
  render.introTimer = setTimeout(() => view.classList.remove('view-in', 'intro'), 700);
  if (!ui.flash) scrollTo(0, 0);
}
function refresh() {
  saveDb();
  if (!session) return;
  const { name, id } = route();
  const keep = (fn) => { const y = scrollY; fn(); scrollTo(0, y); };
  if (name === 'board') paintBoard();
  else if (name === 'stage') keep(() => paintStage(id));
  else if (name === 'job') keep(() => paintJob(id));
  else if (name === 'summary') keep(paintSummary);
  else if (name === 'history') keep(paintHistory);
  else if (name === 'activity') keep(paintActivity);
  else if (name === 'team') keep(paintTeam);
  else if (name === 'services') keep(paintServices);
  else if (name === 'find') paintFind();
  paintNav(name);
}
addEventListener('hashchange', render);

/* ---------------------------------------------------------------- board */
const activeJobs = () => jobs.filter((j) => j.status !== 'DELIVERED');
function matches(j, q) {
  if (!q.trim()) return true;
  const plate = normPlate(q), digits = q.replace(/\D/g, '');
  return (plate && j.plate.includes(plate)) || j.customer.toLowerCase().includes(q.trim().toLowerCase()) || (digits.length >= 3 && j.phone.includes(digits));
}
function ageInfo(j) {
  const now = Date.now();
  if (isLate(j)) return { text: `Late ${fmtAge(Math.max(MIN, now - j.expectedAt))}`, cls: 'late', title: 'Past the promised time' };
  if (j.status === 'READY_FOR_DELIVERY') return { text: `Waiting ${fmtAge(now - j.stageAt)}`, cls: 'ready', title: 'Waiting for pickup' };
  return { text: fmtAge(now - j.stageAt), cls: '', title: 'Time in this stage' };
}
function jobCard(j) {
  const s = STAGE[j.status], i = FLOW.indexOf(j.status), age = ageInfo(j);
  const final = j.status === 'READY_FOR_DELIVERY';
  const extras = [j.photos.length ? `${j.photos.length} photo${j.photos.length === 1 ? '' : 's'}` : '', j.notes ? 'Note' : ''].filter(Boolean);
  return `<article class="job${isLate(j) ? ' is-late' : ''}" data-card="${j.id}" style="--stage:${s.tone}">
    <button class="job-open" data-open="${j.id}" aria-label="${esc(fmtPlate(j.plate))}, ${esc(carName(j))}, ${s.label}">
      <span class="plate">${esc(fmtPlate(j.plate))}</span>
      <span class="job-sub">${esc(carName(j) || 'Vehicle')} · ${esc(j.customer)}</span>
      <span class="job-svc">${esc(svc(j.service).name)}</span>
      <span class="job-foot">
        <span class="job-due">${j.expectedAt ? `Due <b class="mono">${fmtTime(j.expectedAt)}</b>` : 'No due time'}</span>
        <span class="age ${age.cls}" title="${age.title}">${age.text}</span>
      </span>
      ${extras.length ? `<span class="job-extras">${extras.map((x) => `<span>${x}</span>`).join('')}</span>` : ''}
    </button>
    <div class="track" aria-hidden="true">${ACTIVE.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>
    <button class="act${final ? ' final' : ''}" data-next="${j.id}"><span>${s.action}</span>${final ? ICON.check : ICON.arrow}</button>
  </article>`;
}

function paintBoard() {
  const act = activeJobs();
  const found = act.filter((j) => matches(j, ui.query));
  const late = found.filter(isLate).length;
  const ready = found.filter((j) => j.status === 'READY_FOR_DELIVERY').length;
  const money = jobs.filter((j) => j.payment && j.payment.method !== 'UNPAID').reduce((s, j) => s + j.payment.amount, 0);

  const desktopCols = ACTIVE.map((st) => {
    const list = found.filter((j) => j.status === st).sort((a, b) => a.stageAt - b.stageAt);
    return `<section class="col" data-drop="${st}" style="--stage:${STAGE[st].tone}">
      <header class="col-head"><span class="dot"></span><b title="${STAGE[st].label}">${STAGE[st].col}</b><span class="n">${list.length}</span></header>
      <div class="stagger">${list.map(jobCard).join('') || '<div class="empty">Empty</div>'}</div>
    </section>`;
  }).join('');

  const groupCounts = GROUPS.map((g) => ({ ...g, n: found.filter((j) => g.stages.includes(j.status)).length }));
  view.innerHTML = `
    <div class="stat-strip">
      <div class="stat"><span>In the bay</span><b>${act.length}</b><small>${jobs.length} received today</small></div>
      <div class="stat is-ok"><span>Ready</span><b>${ready}</b><small>waiting for pickup</small></div>
      <div class="stat ${late ? 'is-bad' : ''}"><span>Late</span><b>${late}</b><small>past promised time</small></div>
      ${isOwner() ? `<div class="stat is-money"><span>Collected</span><b>${inr(money)}</b><small>cash, UPI and card</small></div>`
        : `<div class="stat"><span>My updates</span><b>${myUpdatesToday()}</b><small>today</small></div>`}
    </div>
    ${ui.query ? `<div class="board-bar"><span class="chip accent">Search: ${esc(ui.query)}</span><button class="btn ghost" data-clear-search>Clear</button></div>` : ''}
    <div class="only-desktop columns">${desktopCols}</div>
    <div class="only-mobile-block">
      <nav class="seg" aria-label="Open a group of cars">
        <a href="#/stage/ALL" aria-current="page" style="--stage:var(--accent)"><b>${found.length}</b>All</a>
        ${groupCounts.map((g) => `<a href="#/stage/group-${g.id}" style="--stage:${STAGE[g.stages[0]].tone}"><b>${g.n}</b>${g.label}</a>`).join('')}
      </nav>
      ${stageMap(found)}
      <p class="map-hint">Tap a stage to see its cars · press and hold a car to move it</p>
    </div>`;

  if (ui.flash) {
    const el = $(`[data-card="${ui.flash}"]`);
    ui.flash = null;
    el?.classList.add('flash');
  }
}

/* ---------------------------------------------------------------- move window (press and hold a car) */
function openMoveSheet(j) {
  const cur = FLOW.indexOf(j.status);
  const rows = FLOW.map((st, i) => {
    const rule = dropRule(j, st);
    const label = rule === 'current' ? 'Here now' : rule === 'next' ? (st === 'DELIVERED' ? 'Hand over' : 'Move here') : rule === 'back' ? 'Move back' : 'One step at a time';
    return `<button class="move-row is-${rule}" style="--stage:${STAGE[st].tone}" ${rule === 'next' || rule === 'back' ? `data-move="${j.id}|${st}"` : 'disabled'}>
      <span class="move-step">${i + 1}</span><span class="move-name">${STAGE[st].label}</span><span class="move-tag">${label}</span></button>`;
  }).join('');
  openSheet(`<h2>Move ${esc(fmtPlate(j.plate))}</h2>
    <p class="muted">${esc(carName(j) || 'Vehicle')} · now in <b>${STAGE[j.status].label}</b></p>
    <div class="move-list" role="list">${rows}</div>
    <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn" data-open-job="${j.id}">Open details</button></div>`);
  if (cur >= 0) navigator.vibrate?.(8);
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-move],[data-open-job]');
  if (!t) return;
  if (t.dataset.openJob) { closeSheet(); location.hash = `#/job/${t.dataset.openJob}`; return; }
  const [id, st] = t.dataset.move.split('|');
  const j = byId(id);
  closeSheet();
  const rule = dropRule(j, st);
  if (rule === 'next') advance(id);        // hand-over still asks how the customer paid
  else if (rule === 'back') stepBack(id);
});

/* ---------------------------------------------------------------- stage map (phone board) */
// Snake layout: Received → Started ↓ Washing → Washed ↓ Ready
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
function stageTile(st, list) {
  const late = list.filter(isLate).length;
  const oldest = list.length ? Math.max(...list.map((j) => Date.now() - j.stageAt)) : 0;
  const sub = late ? `<span class="tile-late">${late} late</span>`
    : list.length ? `<span>longest ${fmtAge(oldest)}</span>` : '<span>empty</span>';
  return `<a class="stage-tile${list.length ? '' : ' is-empty'}${late ? ' has-late' : ''}" href="#/stage/${st}" data-drop="${st}" style="--stage:${STAGE[st].tone}"
      aria-label="${STAGE[st].label}: ${list.length} car${list.length === 1 ? '' : 's'}${late ? `, ${late} late` : ''}">
    <b>${list.length}</b><strong>${STAGE[st].col}</strong>${sub}</a>`;
}
function stageMap(found) {
  const at = (st) => found.filter((j) => j.status === st);
  return `<div class="stage-map">
    ${stageTile('RECEIVED', at('RECEIVED'))}
    <span class="flow-arrow a-to-started">${ARROW}</span>
    ${stageTile('WASH_STARTED', at('WASH_STARTED'))}
    <span class="flow-arrow a-to-washing">${ARROW}</span>
    ${stageTile('WASH_COMPLETE', at('WASH_COMPLETE'))}
    <span class="flow-arrow a-to-washed">${ARROW}</span>
    ${stageTile('WASHING', at('WASHING'))}
    <span class="flow-arrow a-to-ready">${ARROW}</span>
    ${stageTile('READY_FOR_DELIVERY', at('READY_FOR_DELIVERY'))}
  </div>`;
}

/* ---------------------------------------------------------------- stage list (tap a tile) */
function stageKeyInfo(key) {
  // "group-WASHING" is the Waiting / Washing / Ready group; plain "WASHING" is the single stage
  if (key === 'ALL') return { label: 'All cars', stages: ACTIVE };
  if (key.startsWith('group-')) {
    const g = GROUPS.find((x) => x.id === key.slice(6));
    return g ? { label: g.label, stages: g.stages } : null;
  }
  return STAGE[key] ? { label: STAGE[key].label, stages: [key] } : null;
}
function paintStage(key) {
  const info = stageKeyInfo(key);
  if (!info) { location.hash = '#/board'; return; }
  const found = activeJobs().filter((j) => matches(j, ui.query));
  const total = found.filter((j) => info.stages.includes(j.status)).length;
  $('#viewTitle').textContent = info.label;
  $('#viewMeta').textContent = `${total} car${total === 1 ? '' : 's'}`;
  const sections = info.stages.map((st) => {
    const list = found.filter((j) => j.status === st).sort((a, b) => a.stageAt - b.stageAt);
    if (!list.length && info.stages.length > 1) return '';
    return `<section class="col" data-drop="${st}" style="--stage:${STAGE[st].tone}">
      ${info.stages.length > 1 ? `<header class="col-head"><span class="dot"></span><b title="${STAGE[st].label}">${STAGE[st].col}</b><span class="n">${list.length}</span></header>` : ''}
      <div class="stagger">${list.map(jobCard).join('') || `<div class="empty">No cars in ${STAGE[st].label.toLowerCase()} right now.</div>`}</div>
    </section>`;
  }).join('') || '<div class="empty">No cars here right now.</div>';
  view.innerHTML = `
    <div class="board-bar"><a class="btn ghost" href="#/board">← Board</a><span class="stage-count">${total} in ${esc(info.label.toLowerCase())}</span></div>
    <div class="grid">${sections}</div>
    ${total ? '<p class="map-hint">Press and hold a car to move it to another stage</p>' : ''}`;
  if (ui.flash) {
    const el = $(`[data-card="${ui.flash}"]`);
    ui.flash = null;
    el?.classList.add('flash');
  }
}

/* ---------------------------------------------------------------- job detail */
function paintJob(id) {
  const j = byId(id);
  if (!j) { view.innerHTML = '<div class="empty">Job not found. <a href="#/board">Back to board</a></div>'; return; }
  const s = STAGE[j.status], service = svc(j.service), now = Date.now();
  const next = FLOW[FLOW.indexOf(j.status) + 1];
  const reached = {};
  for (const h of j.history) { if (h.kind === 'REVERT') delete reached[h.from]; else reached[h.to] = h; }
  const steps = FLOW.map((st) => {
    const h = reached[st];
    const cls = st === j.status && st !== 'DELIVERED' ? 'now' : h ? 'done' : '';
    return `<li class="${cls}" style="--stage:${STAGE[st].tone}"><span class="pin"></span><span>${STAGE[st].label}${h ? ` <span class="dim">· ${esc(h.by)}</span>` : ''}</span><time>${h ? fmtTime(h.at) : ''}</time></li>`;
  }).join('');
  const reverts = j.history.filter((h) => h.kind === 'REVERT').map((h) =>
    `<li class="rev"><span class="pin"></span><span>Moved back: ${STAGE[h.from].label} → ${STAGE[h.to].label} · ${esc(h.by)}</span><time>${fmtTime(h.at)}</time></li>`).join('');
  const msgs = !j.notify ? '<p class="dim">Customer opted out of WhatsApp updates.</p>'
    : j.msgs.length ? j.msgs.map((m) => `<div class="msg"><div class="msg-top"><span>${esc(m.event)}</span><span class="chip ${m.state === 'Sent' ? 'ok' : ''}">${m.state}${m.sentAt ? ' ' + fmtTime(m.sentAt) : ''}</span></div>
        <p>To ${esc(m.to)} — “${esc(m.text)}”${m.photo ? '<br>After photo attached' : ''}</p></div>`).join('')
    : '<p class="dim">No updates sent yet.</p>';
  const late = isLate(j);
  const age = ageInfo(j);
  const photoKind = ['RECEIVED', 'WASH_STARTED'].includes(j.status) ? 'BEFORE' : 'AFTER';
  const durations = [];
  if (reached.WASH_STARTED && reached.WASH_COMPLETE) durations.push(`Wash took ${fmtAge(reached.WASH_COMPLETE.at - reached.WASH_STARTED.at)}`);
  if (j.deliveredAt) durations.push(`Turnaround ${fmtAge(j.deliveredAt - j.receivedAt)}`);

  view.innerHTML = `
    <div class="board-bar"><a class="btn ghost" href="#/board">← Board</a><span class="dim mono">#${j.number}</span></div>
    <div class="hero" style="--stage:${s.tone}">
      <div>
        <div class="plate">${esc(fmtPlate(j.plate))}</div>
        <p class="muted" style="margin-top:6px">${esc(carName(j) || 'Vehicle')} · ${esc(service.name)}${isOwner() ? ` · ${inr(jobPrice(j))}` : ''}</p>
        <div class="hero-row" style="margin-top:var(--s3)">
          <span class="stage-pill">${s.label}</span>
          <span class="chip ${age.cls === 'late' ? 'bad' : ''}">${age.text}</span>
          ${paymentChip(j)}
        </div>
      </div>
      <div class="quick">
        <a href="tel:+91${j.phone}">${ICON.phone}Call</a>
        <a href="https://wa.me/91${j.phone}?text=${encodeURIComponent(`Hi ${j.customer}, track your vehicle ${fmtPlate(j.plate)} live at ${BUSINESS}: ${trackUrl(j)}`)}" target="_blank" rel="noopener noreferrer">${ICON.chat}Send link</a>
        <button data-shot-add="${j.id}|${photoKind}">${ICON.camera}${photoKind === 'BEFORE' ? 'Before' : 'After'}</button>
      </div>
    </div>

    <div class="grid two" style="margin-top:var(--s4)">
      <section class="panel"><div class="panel-head"><h2>Progress</h2>${durations.length ? `<span class="chip">${durations.join(' · ')}</span>` : ''}</div>
        <ol class="steps">${steps}${reverts}</ol></section>
      <section class="panel"><div class="panel-head"><h2>Details</h2></div>
        <dl class="kv">
          <dt>Customer</dt><dd>${esc(j.customer)} <span class="dim mono">${fmtPhone(j.phone)}</span></dd>
          <dt>Received</dt><dd><span class="mono">${fmtTime(j.receivedAt)}</span> · by ${esc(j.createdBy)}</dd>
          <dt>Promised</dt><dd>${j.expectedAt ? `<span class="mono">${fmtTime(j.expectedAt)}</span>` : '—'} ${late ? `<span class="chip bad">late ${fmtAge(Math.max(MIN, now - j.expectedAt))}</span>` : ''}</dd>
          ${isOwner() ? `<dt>Payment</dt><dd>${paymentDetail(j)}</dd>` : ''}
          <dt>Visits</dt><dd>${visits(j.plate)} for this vehicle</dd>
          <dt>Notes</dt><dd>${j.notes ? esc(j.notes) : '—'}</dd>
        </dl></section>
      <section class="panel wide"><div class="panel-head"><h2>Photos</h2></div>
        <div class="grid two">${shotGroup(j, 'BEFORE')}${shotGroup(j, 'AFTER')}</div></section>
      <section class="panel wide"><div class="panel-head"><h2>Customer updates</h2></div>${msgs}</section>
    </div>
    ${next ? `<div style="margin-top:var(--s5)"><button class="btn primary lg block" data-next="${j.id}">${s.action}${j.status === 'READY_FOR_DELIVERY' ? ICON.check : ICON.arrow}</button></div>` : ''}`;
}

/* ---------------------------------------------------------------- payments */
function paymentChip(j) {
  if (!isOwner() || !j.payment) return '';
  return j.payment.method === 'UNPAID'
    ? `<span class="chip bad">Unpaid ${inr(j.payment.amount)}</span>`
    : `<span class="chip money">${payName(j.payment.method)} ${inr(j.payment.amount)}</span>`;
}
function paymentDetail(j) {
  if (!j.payment) return `<span class="dim">Collect ${inr(jobPrice(j))} at hand-over</span>`;
  if (j.payment.method !== 'UNPAID') return `${paymentChip(j)} <span class="dim mono">${fmtTime(j.payment.at)}</span>`;
  return `${paymentChip(j)}<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${PAY.filter((p) => p.v !== 'UNPAID')
    .map((p) => `<button class="btn" style="min-height:40px;padding:0 14px;font-size:13px" data-pay="${j.id}|${p.v}">${p.name}</button>`).join('')}</div>`;
}
function markPaid(id, method) {
  const j = byId(id);
  if (!j?.payment || j.payment.method !== 'UNPAID') return;
  j.payment = { ...j.payment, method, at: Date.now(), by: me(), late: true };
  toast(`${fmtPlate(j.plate)} · ${inr(j.payment.amount)} collected`, `Paid by ${payName(method)}`);
  refresh();
}

/* ---------------------------------------------------------------- actions */
function advance(id) {
  const j = byId(id);
  if (!j || j.status === 'DELIVERED') return;
  if (j.status === 'READY_FOR_DELIVERY') return openHandover(j);
  step(id);
}
function step(id, payMethod) {
  const j = byId(id);
  const from = j.status, to = FLOW[FLOW.indexOf(from) + 1];
  if (!to) return;
  const prevStageAt = j.stageAt, at = Date.now();
  j.status = to; j.stageAt = at;
  j.history.push({ kind: 'ADVANCE', from, to, at, by: me() });
  let note = '';
  if (to === 'DELIVERED') {
    const amount = jobPrice(j);
    j.deliveredAt = at;
    j.payment = { method: payMethod, amount, at, by: me() };
    note = !isOwner() ? `Payment: ${payName(payMethod)}` : payMethod === 'UNPAID' ? `${inr(amount)} marked unpaid` : `${inr(amount)} received · ${payName(payMethod)}`;
  }
  const sent = notify(j, to);
  undoState = { id, from, to, prevStageAt };
  ui.flash = id;
  toast(`${fmtPlate(j.plate)} → ${STAGE[to].label}`, sent ? `WhatsApp sent to ${j.customer}` : note, true);
  refresh();
}
function stepBack(id) {
  const j = byId(id);
  const i = FLOW.indexOf(j.status);
  if (i <= 0 || j.status === 'DELIVERED') return;
  const from = j.status, to = FLOW[i - 1], prevStageAt = j.stageAt;
  const entered = [...j.history].reverse().find((h) => h.to === to && h.kind !== 'REVERT');
  j.status = to;
  j.stageAt = entered ? entered.at : Date.now();
  j.history.push({ kind: 'REVERT', from, to, at: Date.now(), by: me() });
  undoState = { id, from, to, prevStageAt, wasBack: true };
  ui.flash = id;
  toast(`${fmtPlate(j.plate)} moved back`, `Now in ${STAGE[to].label}`, true);
  refresh();
}
function runUndo() {
  const u = undoState;
  undoState = null;
  if (!u) return;
  const j = byId(u.id);
  if (!j || j.status !== u.to) return;
  j.status = u.from; j.stageAt = u.prevStageAt;
  j.history.push({ kind: u.wasBack ? 'ADVANCE' : 'REVERT', from: u.to, to: u.from, at: Date.now(), by: me() });
  if (u.to === 'DELIVERED') { j.deliveredAt = null; j.payment = null; }
  ui.flash = j.id;
  toast('Undone', `${fmtPlate(j.plate)} is back in ${STAGE[u.from].label}`);
  refresh();
}
function notify(j, status) {
  if (!j.notify || !NOTIFY[status] || j.msgs.some((m) => m.key === status)) return false;
  const m = makeMsg(j, status, Date.now(), 'Queued');
  j.msgs.push(m);
  setTimeout(() => { m.state = 'Sent'; m.sentAt = Date.now(); saveDb(); if (route().name === 'job') refresh(); }, 1400);
  return true;
}
function toast(title, sub, withUndo) {
  const el = $('#toast');
  el.innerHTML = `<div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>${withUndo ? '<button data-undo>Undo</button>' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; undoState = null; }, withUndo ? 6000 : 3200);
}

/* ---------------------------------------------------------------- sheets */
function openSheet(html, onOpen) {
  $('#sheet').innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  $('#scrim').addEventListener('click', (e) => { if (e.target.id === 'scrim') closeSheet(); });
  onOpen?.();
}
const closeSheet = () => { $('#sheet').innerHTML = ''; };

function openHandover(j) {
  const prev = $('#sheet input[name="pay"]:checked')?.value;
  openSheet(`<h2>Hand over this vehicle?</h2>
    <p class="muted">${esc(fmtPlate(j.plate))} · ${esc(carName(j))} · ${esc(j.customer)}</p>
    <div class="grid two" style="margin-top:var(--s4)">${shotGroup(j, 'BEFORE', false)}${shotGroup(j, 'AFTER', true)}</div>
    <fieldset style="margin-top:var(--s4)"><legend>${isOwner() ? `Payment · ${inr(jobPrice(j))} for ${esc(svc(j.service).name)}` : 'How did the customer pay?'}</legend>
      <div class="opts inline">${PAY.map((p) => `<label class="opt"><input type="radio" name="pay" value="${p.v}"${p.v === prev ? ' checked' : ''}><span>${p.name}</span></label>`).join('')}</div>
      <p class="err" id="payErr"></p></fieldset>
    <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-handover="${j.id}">Confirm hand-over${ICON.check}</button></div>`);
}

/* ---------------------------------------------------------------- photos */
const shotsOf = (j, kind) => j.photos.filter((p) => p.kind === kind);
const kindLabel = (kind) => (kind === 'BEFORE' ? 'Before' : 'After');
const canDeleteShot = (p) => !p.sample && p.by === me() && Date.now() - p.at < DELETE_WINDOW;

function shotGroup(j, kind, allowAdd = true) {
  const list = shotsOf(j, kind);
  const thumbs = list.map((p, i) => `<button class="shot" data-shot-view="${j.id}|${kind}|${i}" aria-label="${kindLabel(kind)} photo ${i + 1}"><img src="${p.url}" alt="" loading="lazy"><time>${fmtTime(p.at)}</time></button>`).join('');
  const add = allowAdd && list.length < MAX_PHOTOS ? `<button class="shot-add" data-shot-add="${j.id}|${kind}">${ICON.camera}Add</button>` : '';
  return `<div><div class="panel-head"><h2>${kindLabel(kind)} · ${list.length}</h2></div><div class="shots">${thumbs}${add}${!list.length && !add ? '<span class="dim">None</span>' : ''}</div></div>`;
}
function renderDraftShots() {
  const el = $('#draftShots');
  if (!el) return;
  el.innerHTML = draftPhotos.map((p, i) => `<div class="shot"><img src="${p.url}" alt="Before photo ${i + 1}"><button type="button" class="shot-x" data-draft-remove="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`).join('')
    + (draftPhotos.length < MAX_PHOTOS ? `<button type="button" class="shot-add" data-shot-add="draft|BEFORE">${ICON.camera}Add</button>` : '');
}
function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
    input.addEventListener('change', () => resolve([...input.files]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}
async function shrink(file, maxSide = 1280, quality = .78) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', quality);
}
async function addShots(files, kind, list, done, btn) {
  if (!files.length) return;
  const room = MAX_PHOTOS - list.filter((p) => p.kind === kind).length;
  if (room <= 0) return toast('Photo limit reached', `Up to ${MAX_PHOTOS} ${kindLabel(kind).toLowerCase()} photos per job`);
  btn?.setAttribute('aria-busy', 'true');
  let added = 0, bad = 0;
  for (const file of files.slice(0, room)) {
    if (!file.type.startsWith('image/') || file.size > MAX_UPLOAD) { bad++; continue; }
    try { list.push({ id: 'p' + ++photoSeq, kind, url: await shrink(file), at: Date.now(), by: me() }); added++; } catch { bad++; }
  }
  btn?.removeAttribute('aria-busy');
  const over = Math.max(0, files.length - room);
  toast(added ? `${added} ${kindLabel(kind).toLowerCase()} photo${added === 1 ? '' : 's'} added` : 'No photos added',
    [bad && `${bad} not a supported image (max 20 MB)`, over && `${over} over the limit`].filter(Boolean).join(' · '));
  done();
}
function openLightbox(jobId, kind, index) { lb = { jobId, kind, index }; paintLightbox(); }
const closeLightbox = () => { lb = null; $('#lightbox').innerHTML = ''; };
const stepLightbox = (d) => { if (lb) { lb.index += d; paintLightbox(); } };
function paintLightbox() {
  const j = byId(lb.jobId);
  const list = j ? shotsOf(j, lb.kind) : [];
  if (!list.length) return closeLightbox();
  lb.index = Math.max(0, Math.min(lb.index, list.length - 1));
  const p = list[lb.index];
  const mins = Math.ceil((DELETE_WINDOW - (Date.now() - p.at)) / MIN);
  $('#lightbox').innerHTML = `<div class="lb" role="dialog" aria-modal="true" aria-label="Photo viewer">
    <div class="lb-bar"><div><b class="mono">${fmtPlate(j.plate)}</b><small>${kindLabel(lb.kind)} ${lb.index + 1} of ${list.length} · ${fmtTime(p.at)} · ${esc(p.by)}</small></div>
      <button class="icon-btn" data-lb-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="lb-stage">
      <button class="lb-nav prev" data-lb-prev aria-label="Previous"${lb.index === 0 ? ' disabled' : ''}>‹</button>
      <img src="${p.url}" alt="${kindLabel(lb.kind)} photo ${lb.index + 1}">
      <button class="lb-nav next" data-lb-next aria-label="Next"${lb.index === list.length - 1 ? ' disabled' : ''}>›</button>
    </div>
    <div class="lb-foot">${canDeleteShot(p) ? `<button class="btn danger" data-lb-delete>Delete photo · ${mins} min left</button>` : 'Locked as a job record — only the owner can remove it'}</div>
  </div>`;
  const stage = $('.lb-stage');
  let x0 = null;
  stage.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
  });
}
function deleteShot() {
  const j = byId(lb.jobId);
  const p = shotsOf(j, lb.kind)[lb.index];
  if (!p || !canDeleteShot(p) || !confirm('Delete this photo?')) return;
  j.photos.splice(j.photos.indexOf(p), 1);
  URL.revokeObjectURL(p.url);
  paintLightbox();
  refresh();
  toast('Photo deleted');
}

/* ---------------------------------------------------------------- check in */
function paintNew() {
  draftPhotos = [];
  view.innerHTML = `<form class="form" id="checkin" novalidate>
    <section class="panel">
      <div class="panel-head"><h2>Vehicle and customer</h2></div>
      <div class="grid">
        <div class="field" id="f-plate"><label class="label" for="plate">Vehicle number</label>
          <input class="input plate-input" id="plate" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="KL 29 AB 1234" enterkeyhint="next">
          <p class="err"></p></div>
        <div id="known" class="notice" hidden></div>
        <div class="field" id="f-phone"><label class="label" for="phone">Mobile number</label>
          <span class="prefix"><span>+91</span><input class="input" id="phone" inputmode="tel" autocomplete="off" placeholder="98470 00001" enterkeyhint="next"></span>
          <p class="err"></p></div>
        <div class="field" id="f-name"><label class="label" for="name">Customer name</label>
          <input class="input" id="name" autocomplete="off" autocapitalize="words" enterkeyhint="next"><p class="err"></p></div>
      </div>
    </section>

    <section class="panel">
      <fieldset id="f-service"><legend>Service</legend>
        <div class="opts">${SERVICES.filter((s) => s.active).map((s) => `<label class="opt"><input type="radio" name="service" value="${s.id}"><span>${esc(s.name)}<small>${isOwner() ? `${inr(s.price)} · ` : ''}${fmtMins(s.mins)}</small></span></label>`).join('')}</div>
        <p class="err"></p></fieldset>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Optional</h2></div>
      <div class="grid">
        <div class="row2">
          <div class="field"><label class="label" for="make">Make <em>optional</em></label><input class="input" id="make" autocomplete="off" placeholder="Hyundai"></div>
          <div class="field"><label class="label" for="model">Model <em>optional</em></label><input class="input" id="model" autocomplete="off" placeholder="Creta"></div>
        </div>
        <fieldset><legend>Promised time</legend>
          <div class="opts inline">${ETA.map((o) => `<label class="opt"><input type="radio" name="eta" value="${o.v}"${o.v === 'svc' ? ' checked' : ''}><span>${o.l}</span></label>`).join('')}</div>
          <p class="dim" id="etaHint" style="font-size:13px"></p></fieldset>
        <fieldset><legend>Before photos</legend>
          <p class="dim" style="font-size:13px">Record existing dents or scratches.</p>
          <div class="shots" id="draftShots"></div></fieldset>
        <div class="field"><label class="label" for="notes">Notes <em>optional</em></label>
          <textarea class="input" id="notes" placeholder="Valuables, special requests…"></textarea></div>
        <label class="check"><input type="checkbox" id="notify" checked> Send WhatsApp updates to the customer</label>
      </div>
    </section>

    <button class="btn primary lg block" type="submit">Check in vehicle${ICON.arrow}</button>
  </form>`;

  const f = (id) => document.getElementById(id);
  const checked = (name) => $(`input[name="${name}"]:checked`)?.value;
  const setErr = (id, msg) => { const el = f(id); el.classList.toggle('invalid', !!msg); $('.err', el).textContent = msg || ''; };
  const showKnown = (text, warn) => { const b = f('known'); b.className = warn ? 'notice warn' : 'notice'; b.textContent = text; b.hidden = !text; };
  const eta = () => {
    const v = checked('eta'), s = svc(checked('service'));
    const t = v === 'svc' ? (s ? Date.now() + s.mins * MIN : null) : v === 'none' ? null : Date.now() + Number(v) * MIN;
    f('etaHint').textContent = t ? `Ready by about ${fmtTime(roundUp5(t))}` : v === 'svc' ? 'Pick a service to estimate' : 'No promised time';
    return t ? roundUp5(t) : null;
  };

  f('plate').addEventListener('input', () => {
    setErr('f-plate', '');
    const p = normPlate(f('plate').value);
    const v = p.length >= 6 ? findVehicle(p) : null;
    if (!v) return showKnown('');
    if (v.active) return showKnown(`Already on the board — ${STAGE[v.active.status].label}.`, true);
    if (!f('phone').value) f('phone').value = `${v.phone.slice(0, 5)} ${v.phone.slice(5)}`;
    if (!f('name').value) f('name').value = v.customer;
    if (!f('make').value) f('make').value = v.make || '';
    if (!f('model').value) f('model').value = v.model || '';
    const n = visits(p);
    showKnown(`Returning vehicle · ${n} previous visit${n === 1 ? '' : 's'} · last service ${svc(v.service).name}. Details filled in.`);
  });
  f('plate').addEventListener('blur', () => { const p = normPlate(f('plate').value); if (p) f('plate').value = fmtPlate(p); });
  f('phone').addEventListener('input', () => {
    setErr('f-phone', '');
    const p = normPhone(f('phone').value);
    const c = p && findCustomer(p);
    if (c && !f('name').value) { f('name').value = c.customer; if (f('known').hidden) showKnown(`Existing customer: ${c.customer}`); }
  });
  f('phone').addEventListener('blur', () => { const p = normPhone(f('phone').value); if (p) f('phone').value = `${p.slice(0, 5)} ${p.slice(5)}`; });
  f('name').addEventListener('input', () => setErr('f-name', ''));
  f('checkin').addEventListener('change', (e) => { if (e.target.name === 'service') setErr('f-service', ''); eta(); });

  f('checkin').addEventListener('submit', (e) => {
    e.preventDefault();
    const plate = normPlate(f('plate').value), phone = normPhone(f('phone').value), name = f('name').value.trim(), service = checked('service');
    const errs = [];
    if (plate.length < 4 || /[^A-Z0-9]/.test(plate)) errs.push(['f-plate', 'Enter the vehicle number']);
    else if (jobs.some((j) => j.plate === plate && j.status !== 'DELIVERED')) errs.push(['f-plate', 'This vehicle is already on the board']);
    if (!phone) errs.push(['f-phone', 'Enter a valid 10-digit mobile number']);
    if (!name) errs.push(['f-name', 'Enter the customer name']);
    if (!service) errs.push(['f-service', 'Choose a service']);
    ['f-plate', 'f-phone', 'f-name', 'f-service'].forEach((id) => setErr(id, ''));
    if (errs.length) {
      errs.forEach(([id, msg]) => setErr(id, msg));
      const first = f(errs[0][0]);
      first.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      (first.querySelector('input') || first).focus({ preventScroll: true });
      return;
    }
    const at = Date.now();
    const job = {
      id: 'j' + ++seq, number: seq, plate, make: f('make').value.trim(), model: f('model').value.trim(), customer: name, phone,
      service, price: svc(service).price, status: 'RECEIVED', receivedAt: at, stageAt: at, expectedAt: eta(), notes: f('notes').value.trim(),
      notify: f('notify').checked, history: [{ kind: 'CREATE', from: null, to: 'RECEIVED', at, by: me() }],
      msgs: [], photos: draftPhotos, deliveredAt: null, payment: null, createdBy: me(),
    };
    jobs.push(job);
    const sent = notify(job, 'RECEIVED');
    saveDb();
    ui.flash = job.id; ui.group = 'ALL'; ui.query = '';
    location.hash = '#/board';
    toast(`${fmtPlate(plate)} checked in`, [sent && `WhatsApp sent to ${name}`, job.photos.length && `${job.photos.length} before photos`].filter(Boolean).join(' · '));
  });

  eta();
  renderDraftShots();
  f('plate').focus();
}

/* ---------------------------------------------------------------- find (number pad) */
function paintFind() {
  const digits = ui.query.replace(/\D/g, '').slice(0, 4);
  const hits = digits.length ? activeJobs().filter((j) => j.plate.includes(digits)) : [];
  view.innerHTML = `<div class="grid" style="max-width:520px;margin:0 auto">
    <div class="pad-display mono">${[0, 1, 2, 3].map((i) => (digits[i] ? `<b>${digits[i]}</b>` : '<span>·</span>')).join('')}</div>
    <p class="dim" style="text-align:center;margin-top:-8px">Type the last digits of the number plate</p>
    <div class="grid">${hits.map(jobCard).join('') || `<div class="empty">${digits.length ? 'No vehicle in the bay matches those digits.' : 'Start typing to find a vehicle.'}</div>`}</div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-pad="${n}">${n}</button>`).join('')}
      <button data-pad="clear" aria-label="Clear">⌫</button><button data-pad="0">0</button><button data-pad="done" aria-label="Full board">Board</button></div>
  </div>`;
}

/* ---------------------------------------------------------------- history */
function paintHistory() {
  const done = jobs.filter((j) => j.status === 'DELIVERED').sort((a, b) => b.deliveredAt - a.deliveredAt);
  view.innerHTML = `<div class="grid">${done.map((j) => `<button class="hist-row" data-open="${j.id}">
      <span class="plate">${esc(fmtPlate(j.plate))}</span>
      <span><b>${esc(j.customer)}</b><br><span class="dim">${esc(svc(j.service).name)} · <span class="mono">${fmtTime(j.receivedAt)} → ${fmtTime(j.deliveredAt)}</span> · ${fmtAge(j.deliveredAt - j.receivedAt)}</span></span>
      ${paymentChip(j)}
    </button>`).join('') || '<div class="empty">No deliveries yet today.</div>'}</div>`;
}

/* ---------------------------------------------------------------- daily summary */
function summarise() {
  const now = Date.now();
  const all = jobs.slice();
  const delivered = all.filter((j) => j.status === 'DELIVERED');
  const inBay = all.filter((j) => j.status !== 'DELIVERED').sort((a, b) => a.receivedAt - b.receivedAt);
  const paid = delivered.filter((j) => j.payment && j.payment.method !== 'UNPAID');
  const unpaidJobs = delivered.filter((j) => j.payment?.method === 'UNPAID');
  const byMethod = Object.fromEntries(PAY.filter((p) => p.v !== 'UNPAID').map((p) => [p.v, 0]));
  paid.forEach((j) => { byMethod[j.payment.method] += j.payment.amount; });
  const collected = paid.reduce((s, j) => s + j.payment.amount, 0);
  const unpaid = unpaidJobs.reduce((s, j) => s + j.payment.amount, 0);
  const pipeline = inBay.reduce((s, j) => s + jobPrice(j), 0);
  const readyAt = (j) => [...j.history].reverse().find((h) => h.to === 'READY_FOR_DELIVERY' && h.kind !== 'REVERT')?.at;
  const late = delivered.filter((j) => j.expectedAt && readyAt(j) > j.expectedAt).length + inBay.filter(isLate).length;
  const avgTurn = delivered.length ? delivered.reduce((s, j) => s + (j.deliveredAt - j.receivedAt), 0) / delivered.length : 0;
  const services = SERVICES.map((s) => {
    const list = all.filter((j) => j.service === s.id);
    return { ...s, count: list.length, value: list.reduce((t, j) => t + jobPrice(j), 0) };
  }).filter((s) => s.count).sort((a, b) => b.count - a.count);
  const HOUR = 60 * MIN;
  const hourStart = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
  const counts = new Map();
  all.forEach((j) => { const k = hourStart(j.receivedAt); counts.set(k, (counts.get(k) || 0) + 1); });
  const keys = [...counts.keys()].sort((a, b) => a - b);
  const hours = keys.length ? Array.from({ length: Math.round((keys.at(-1) - keys[0]) / HOUR) + 1 }, (_, i) => {
    const t = hourStart(keys[0] + i * HOUR + 30 * MIN);
    return { h: new Date(t).getHours(), n: counts.get(t) || 0 };
  }) : [];
  const busiest = hours.reduce((b, r) => (r.n > (b?.n || 0) ? r : b), null);
  const crew = {};
  all.forEach((j) => j.history.forEach((h) => {
    if (h.kind === 'REVERT') return;
    const s = (crew[h.by] ||= { name: h.by, cars: new Set(), updates: 0, handovers: 0 });
    s.cars.add(j.id); s.updates++;
    if (h.to === 'DELIVERED') s.handovers++;
  }));
  const staff = Object.values(crew).map((s) => ({ ...s, cars: s.cars.size })).sort((a, b) => b.cars - a.cars);
  const returningOf = (j) => (pastVisits[j.plate] || 0) > 0 || pastVehicles.some((v) => v.plate === j.plate || v.phone === j.phone)
    || all.some((o) => o !== j && o.receivedAt < j.receivedAt && (o.plate === j.plate || o.phone === j.phone));
  const returning = all.filter(returningOf).length;
  const uncollected = inBay.filter((j) => j.status === 'READY_FOR_DELIVERY' && now - j.stageAt > 15 * MIN);
  return { now, all, delivered, inBay, collected, unpaid, unpaidJobs, byMethod, pipeline, late, avgTurn, services, hours, busiest, staff, returning, fresh: all.length - returning, uncollected };
}

function summaryText(r) {
  const methods = PAY.filter((p) => p.v !== 'UNPAID' && r.byMethod[p.v]).map((p) => `${p.name} ${inr(r.byMethod[p.v])}`).join(' · ');
  const top = r.services[0];
  const lines = [
    `*${BUSINESS} — daily summary*`, fmtDay(r.now), '',
    `Cars: ${r.all.length} received · ${r.delivered.length} delivered · ${r.inBay.length} in bay`,
    `Collected: ${inr(r.collected)}${methods ? ` (${methods})` : ''}`,
  ];
  if (r.unpaid) lines.push(`Unpaid: ${inr(r.unpaid)} (${r.unpaidJobs.length} car${r.unpaidJobs.length === 1 ? '' : 's'})`);
  if (top) lines.push(`Top service: ${top.name} (${top.count})`);
  if (r.delivered.length) lines.push(`Avg turnaround: ${fmtAge(r.avgTurn)} · Late: ${r.late}`);
  if (r.busiest) lines.push(`Busiest hour: ${hourLabel(r.busiest.h)}–${hourLabel(r.busiest.h + 1)} (${r.busiest.n} cars)`);
  if (r.staff.length) lines.push(`Staff: ${r.staff.map((s) => `${s.name} ${s.cars}`).join(' · ')}`);
  lines.push(`Customers: ${r.fresh} new · ${r.returning} returning`);
  const alerts = [
    ...r.uncollected.map((j) => `Not collected: ${fmtPlate(j.plate)} (ready ${fmtAge(r.now - j.stageAt)})`),
    ...r.unpaidJobs.map((j) => `Unpaid: ${fmtPlate(j.plate)} · ${j.customer} · ${inr(j.payment.amount)}`),
  ];
  if (alerts.length) lines.push('', ...alerts.slice(0, 4), ...(alerts.length > 4 ? [`…and ${alerts.length - 4} more`] : []));
  if (r.inBay.length) lines.push('', `${r.inBay.length} car${r.inBay.length === 1 ? '' : 's'} carried over to tomorrow (${inr(r.pipeline)} pending)`);
  return lines.join('\n');
}
const timeLabel = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`; };
function bars(rows, max, hiIndex = -1) {
  return `<div class="bars">${rows.map((r, i) => `<div class="bar${i === hiIndex ? ' hi' : ''}"><span>${r.label}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${max ? Math.max(3, (r.value / max) * 100) : 0}%"></span></span>
    <span class="bar-v">${r.text}</span></div>`).join('')}</div>`;
}

function paintSummary() {
  const r = summarise();
  const text = summaryText(r);
  const maxSvc = Math.max(0, ...r.services.map((s) => s.count));
  const maxHour = Math.max(0, ...r.hours.map((h) => h.n));
  const methods = PAY.filter((p) => p.v !== 'UNPAID').map((p) => `${p.name} ${inr(r.byMethod[p.v])}`).join(' · ');
  const alerts = [
    ...r.uncollected.map((j) => ({ j, tag: `<span class="chip bad">ready ${fmtAge(r.now - j.stageAt)}, not collected</span>` })),
    ...r.unpaidJobs.map((j) => ({ j, tag: paymentChip(j) })),
    ...r.inBay.filter(isLate).map((j) => ({ j, tag: `<span class="chip bad">late ${fmtAge(r.now - j.expectedAt)}</span>` })),
  ];

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Cars received</span><b data-count="${r.all.length}">${r.all.length}</b><small>${r.delivered.length} delivered · ${r.inBay.length} in bay</small></div>
      <div class="kpi" style="--tone:var(--money)"><span>Collected</span><b data-count="${r.collected}" data-money="1">${inr(r.collected)}</b><small>${methods}</small></div>
      <div class="kpi" style="--tone:${r.unpaid ? 'var(--bad)' : 'var(--text)'}"><span>Unpaid</span><b data-count="${r.unpaid}" data-money="1">${inr(r.unpaid)}</b><small>${r.unpaidJobs.length} car${r.unpaidJobs.length === 1 ? '' : 's'} · ${inr(r.pipeline)} still in bay</small></div>
      <div class="kpi"><span>Avg turnaround</span><b>${r.delivered.length ? fmtAge(r.avgTurn) : '—'}</b><small>${r.late} late today</small></div>
    </div>

    <div class="grid two" style="margin-top:var(--s4)">
      <section class="panel"><div class="panel-head"><h2>Services</h2></div>
        ${r.services.length ? bars(r.services.map((s) => ({ label: s.name, value: s.count, text: `${s.count} · ${inr(s.value)}` })), maxSvc, 0) : '<p class="dim">No cars yet.</p>'}</section>
      <section class="panel"><div class="panel-head"><h2>Check-ins by hour</h2>${r.busiest ? `<span class="chip">busiest ${hourLabel(r.busiest.h)}</span>` : ''}</div>
        ${r.hours.length ? bars(r.hours.map((h) => ({ label: hourLabel(h.h), value: h.n, text: String(h.n) })), maxHour, r.hours.indexOf(r.busiest)) : '<p class="dim">No check-ins yet.</p>'}</section>
      <section class="panel"><div class="panel-head"><h2>Staff</h2></div>
        <table class="tbl"><thead><tr><th>Name</th><th>Cars</th><th>Updates</th><th>Handed over</th></tr></thead>
        <tbody>${r.staff.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.cars}</td><td>${s.updates}</td><td>${s.handovers}</td></tr>`).join('')}</tbody></table></section>
      <section class="panel"><div class="panel-head"><h2>Customers</h2></div>
        <div class="stat-strip" style="margin:0"><div class="stat"><span>New</span><b>${r.fresh}</b></div><div class="stat"><span>Returning</span><b>${r.returning}</b></div></div>
        <p class="dim" style="margin-top:var(--s3);font-size:13px">Ratings appear here once feedback requests are switched on.</p></section>

      <section class="panel wide"><div class="panel-head"><h2>Needs attention</h2><span class="chip ${alerts.length ? 'bad' : 'ok'}">${alerts.length}</span></div>
        ${alerts.length ? `<div class="alerts">${alerts.map(({ j, tag }) => `<button class="alert-row" data-open="${j.id}"><span class="plate">${esc(fmtPlate(j.plate))}</span><span class="dim">${esc(j.customer)} · ${STAGE[j.status].label}</span>${tag}</button>`).join('')}</div>` : '<p class="dim">All clear — nothing pending.</p>'}</section>

      <section class="panel wide"><div class="panel-head"><h2>WhatsApp summary</h2><span class="chip">${report.closedAt ? `day closed ${fmtTime(report.closedAt)}` : 'day in progress'}</span></div>
        <div class="wa">
          <div class="wa-phone"><div class="wa-bubble" id="waText">${esc(text)}</div><div class="wa-time">preview · ${fmtTime(r.now)}</div></div>
          <div class="grid">
            <fieldset><legend>Send to</legend>
              ${CONTACTS.map((c) => `<label class="check"><input type="checkbox" data-recipient="${c.id}"${report.recipients.has(c.id) ? ' checked' : ''}> ${esc(c.name)} <span class="dim mono">${fmtPhone(c.phone)}</span></label>`).join('')}
              <p class="err" id="recipErr"></p></fieldset>
            <div class="field"><label class="label" for="closeTime">Send automatically at</label><input class="input" type="time" id="closeTime" value="${report.closeTime}"></div>
            <p class="dim" style="font-size:13px">Next automatic summary at <b>${timeLabel(report.closeTime)}</b>. Cars still in the bay carry over to tomorrow.</p>
            <button class="btn primary block" data-send>${report.closedAt ? 'Send updated summary' : 'Close day and send summary'}</button>
            <div class="row2"><button class="btn" data-copy>Copy text</button><button class="btn" data-csv>Download CSV</button></div>
          </div>
        </div></section>

      <section class="panel wide"><div class="panel-head"><h2>Sent summaries</h2></div>
        ${report.sent.length ? report.sent.slice().reverse().map((s) => `<div class="msg"><div class="msg-top"><span>${esc(s.to)}</span><span class="chip ${s.state === 'Sent' ? 'ok' : ''}">${s.state} ${fmtTime(s.at)}</span></div><p>${esc(s.kind)} · by ${esc(s.by)}</p></div>`).join('')
          : `<p class="dim">Nothing sent yet. The summary goes out automatically at ${timeLabel(report.closeTime)}.</p>`}</section>
    </div>`;

  $('#closeTime').addEventListener('change', (e) => {
    if (!e.target.value) return;
    report.closeTime = e.target.value;
    writePref('close-time', report.closeTime);
    toast('Schedule updated', `Daily summary at ${timeLabel(report.closeTime)}`);
    refresh();
  });
  countUp(view);
}
function openSend() {
  const to = CONTACTS.filter((c) => report.recipients.has(c.id));
  if (!to.length) { $('#recipErr').textContent = 'Choose at least one person'; return; }
  const r = summarise();
  const closing = !report.closedAt;
  openSheet(`<h2>${closing ? 'Close the day?' : 'Send the updated summary?'}</h2>
    <p class="muted">Goes on WhatsApp to <b>${to.map((c) => esc(c.name)).join(', ')}</b>.</p>
    ${closing && r.inBay.length ? `<div class="notice warn" style="margin-top:var(--s3)">${r.inBay.length} car${r.inBay.length === 1 ? ' is' : 's are'} still in the bay and will carry over.</div>` : ''}
    ${r.unpaidJobs.length ? `<div class="notice warn" style="margin-top:var(--s3)">${inr(r.unpaid)} is still unpaid.</div>` : ''}
    <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-send-confirm>Send summary</button></div>`);
}
function sendSummary() {
  const to = CONTACTS.filter((c) => report.recipients.has(c.id));
  const at = Date.now();
  const kind = report.closedAt ? 'Updated summary (manual)' : 'Day closed (manual)';
  report.closedAt ||= at;
  const rows = to.map((c) => ({ at, to: `${c.name} · ${fmtPhone(c.phone)}`, kind, by: me(), state: 'Queued' }));
  report.sent.push(...rows);
  setTimeout(() => { rows.forEach((row) => { row.state = 'Sent'; }); saveDb(); if (route().name === 'summary') refresh(); }, 1400);
  closeSheet();
  toast('Daily summary sent', `WhatsApp to ${to.map((c) => c.name.split(' ')[0]).join(', ')}`);
  refresh();
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function exportCsv() {
  const head = ['Job', 'Vehicle number', 'Vehicle', 'Customer', 'Service', 'Price', 'Status', 'Received', 'Delivered', 'Turnaround (min)', 'Payment', 'Handled by'];
  const rows = jobs.slice().sort((a, b) => a.number - b.number).map((j) => [
    j.number, fmtPlate(j.plate), carName(j), j.customer, svc(j.service).name, jobPrice(j), STAGE[j.status].label,
    fmtTime(j.receivedAt), j.deliveredAt ? fmtTime(j.deliveredAt) : '', j.deliveredAt ? Math.round((j.deliveredAt - j.receivedAt) / MIN) : '',
    j.payment ? payName(j.payment.method) : 'Pending', [...new Set(j.history.map((h) => h.by))].join(' / '),
  ]);
  const csv = [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `daily-summary-${new Date().toLocaleDateString('en-CA')}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV downloaded', `${rows.length} jobs`);
}
function countUp(root) {
  if (reduced()) return;
  $$('[data-count]', root).forEach((el) => {
    const end = Number(el.dataset.count);
    const money = el.dataset.money === '1';
    if (!end) return;
    const final = el.textContent;
    let done = false;
    const t0 = performance.now();
    const tick = (now) => {
      if (done) return;
      const k = Math.min(1, (now - t0) / 650);
      const v = Math.round(end * (1 - (1 - k) ** 3));
      el.textContent = money ? inr(v) : v.toLocaleString('en-IN');
      if (k < 1) requestAnimationFrame(tick); else done = true;
    };
    el.textContent = money ? inr(0) : '0';
    requestAnimationFrame(tick);
    // Background tabs, printing and screenshots may never run animation frames: always land on the real figure.
    setTimeout(() => { done = true; el.textContent = final; }, 900);
  });
}

/* ---------------------------------------------------------------- navigation per role */
const GLYPH = '<svg viewBox="0 0 32 32"><path d="M16 3.5c-4.8 6-9 10.9-9 16a9 9 0 0 0 18 0c0-5.1-4.2-10-9-16Z"/><path d="M10.6 21.2h10.8M11.6 21.2l1.3-3.2c.3-.7.9-1.1 1.6-1.1h3c.7 0 1.3.4 1.6 1.1l1.3 3.2v2.4H11.6z"/></svg>';
const NAV_ICON = {
  board: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="5.5" height="16" rx="2"/><rect x="9.25" y="4" width="5.5" height="11" rx="2"/><rect x="15.5" y="4" width="5.5" height="7" rx="2"/></svg>',
  activity: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
  new: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  summary: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V10M10 19V5M16 19v-6M21 19H3"/></svg>',
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5L3 8"/><path d="M3 3.5V8h4.5"/><path d="M12 7.5V12l3 1.8"/></svg>',
  team: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 13.8c1.8.7 3 2.5 3 5.2"/></svg>',
  services: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c-3.6 4.4-6.5 8-6.5 11.5a6.5 6.5 0 0 0 13 0c0-3.5-2.9-7.1-6.5-11.5Z"/><path d="M9.5 15.5a2.5 2.5 0 0 0 2.5 2.5"/></svg>',
  find: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.6"/><path d="m20 20-3.6-3.6"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
};
const NAV = {
  OWNER: [['board', 'Board'], ['activity', 'Activity'], ['new', 'Check in'], ['summary', 'Summary'], ['history', 'History'], ['team', 'Team'], ['services', 'Wash types']],
  EMPLOYEE: [['board', 'Board'], ['activity', 'Activity'], ['new', 'Check in'], ['find', 'Find a car']],
};
const TABS = {
  OWNER: [['board', 'Board'], ['activity', 'Activity'], ['new', 'Check in'], ['summary', 'Summary'], ['more', 'More']],
  EMPLOYEE: [['board', 'Board'], ['activity', 'Activity'], ['new', 'Check in'], ['find', 'Find'], ['more', 'More']],
};

function paintNav(current) {
  const role = session.role;
  const active = (n) => n === current || (['job', 'stage'].includes(current) && n === 'board');
  const unread = unreadCount();
  const badge = (n) => (n === 'activity' && unread ? `<i class="nav-badge" aria-label="${unread} new">${unread > 9 ? '9+' : unread}</i>` : '');
  $('#railNav').innerHTML = NAV[role].map(([n, label]) =>
    `<a href="#/${n}" class="${active(n) ? 'active' : ''}"${active(n) ? ' aria-current="page"' : ''}>${NAV_ICON[n]}<span>${label}</span>${badge(n)}</a>`).join('');
  $('#tabbar').innerHTML = TABS[role].map(([n, label]) => n === 'new'
    ? `<a href="#/new" class="tab-cta${active(n) ? ' active' : ''}"><span class="tab-cta-dot" aria-hidden="true">${NAV_ICON.new}</span><span>${label}</span></a>`
    : `<a href="#/${n}" class="${active(n) ? 'active' : ''}"${active(n) ? ' aria-current="page"' : ''}>${NAV_ICON[n]}${badge(n)}<span>${label}</span></a>`).join('');
  $('#who').innerHTML = `<span class="who-dot" aria-hidden="true">${esc(session.name[0])}</span><span class="who-text"><b>${esc(session.name)}</b><small>${isOwner() ? 'Owner' : 'Employee'}</small></span>`;
}

/* ---------------------------------------------------------------- activity feed */
let feedFilter = 'ALL';
// Each event reads as "<who> <pre> <PLATE> <post>", e.g. "Ravi moved KL 29 AB 1234 to Washing".
function allEvents() {
  const out = [];
  for (const j of jobs) {
    const plate = fmtPlate(j.plate);
    for (const h of j.history) {
      const [pre, post] = h.kind === 'CREATE' ? ['checked in', '']
        : h.kind === 'REVERT' ? ['moved', `back to ${STAGE[h.to].label}`]
        : h.to === 'DELIVERED' ? ['handed over', ''] : ['moved', `to ${STAGE[h.to].label}`];
      out.push({ at: h.at, by: h.by, j, plate, pre, post, stage: h.to });
    }
    for (const p of j.photos) if (!p.sample) out.push({ at: p.at, by: p.by, j, plate, pre: `added a ${p.kind === 'BEFORE' ? 'before' : 'after'} photo of`, post: '', stage: j.status });
    if (isOwner() && j.payment?.late) out.push({ at: j.payment.at, by: j.payment.by, j, plate, pre: `collected ${payName(j.payment.method)} payment for`, post: '', stage: 'DELIVERED' });
  }
  return out.sort((a, b) => b.at - a.at);
}
const eventText = (e) => `${e.by} ${e.pre} ${e.plate}${e.post ? ' ' + e.post : ''}`;
const eventLine = (e) => `<b>${esc(e.by)}</b> ${esc(e.pre)} <b class="mono">${esc(e.plate)}</b>${e.post ? ' ' + esc(e.post) : ''}`;
const seenAt = () => Number(readPref('activity-seen-' + (session?.id || '')) || 0);
const unreadCount = () => allEvents().filter((e) => e.at > seenAt() && e.by !== me()).length;
const latestEventAt = () => allEvents()[0]?.at || 0;
function paintActivity() {
  const seen = seenAt();
  const events = allEvents();
  const people = [...new Set(events.map((e) => e.by))];
  const shown = events.filter((e) => feedFilter === 'ALL' || e.by === feedFilter).slice(0, 80);
  const hourAgo = Date.now() - 60 * MIN;
  const group = (list) => list.map((e) => `<button class="feed-row${e.at > seen && e.by !== me() ? ' unread' : ''}" data-open="${e.j.id}" style="--stage:${STAGE[e.stage].tone}">
      <span class="avatar" aria-hidden="true">${esc(e.by[0])}</span>
      <span class="feed-text">${eventLine(e)}<small>${fmtAge(Date.now() - e.at)} ago · ${fmtTime(e.at)} · ${esc(carName(e.j))}</small></span>
      <span class="stage-dot" title="${STAGE[e.stage].label}"></span>
    </button>`).join('');
  const recent = shown.filter((e) => e.at >= hourAgo), earlier = shown.filter((e) => e.at < hourAgo);
  view.innerHTML = `
    <div class="filter-row" role="group" aria-label="Filter by person">
      <button class="pill-btn" aria-pressed="${feedFilter === 'ALL'}" data-feed="ALL">Everyone</button>
      ${people.map((p) => `<button class="pill-btn" aria-pressed="${feedFilter === p}" data-feed="${esc(p)}">${esc(p)}</button>`).join('')}
    </div>
    ${recent.length ? `<section class="panel"><div class="panel-head"><h2>Last hour</h2><span class="chip">${recent.length}</span></div><div class="feed">${group(recent)}</div></section>` : ''}
    ${earlier.length ? `<section class="panel" style="margin-top:var(--s4)"><div class="panel-head"><h2>Earlier today</h2></div><div class="feed">${group(earlier)}</div></section>` : ''}
    ${shown.length ? '' : '<div class="empty">No updates yet.</div>'}`;
  writePref('activity-seen-' + session.id, String(Date.now()));
}
function myUpdatesToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return allEvents().filter((e) => e.by === me() && e.at >= start.getTime()).length;
}

/* ---------------------------------------------------------------- sign in */
// Fixed code until a real SMS/WhatsApp OTP provider is integrated (verification must then move to the server).
const DEMO_OTP = '123456';
let login = { step: 'phone', phone: '', code: '', user: null, tries: 0, err: '' };
function paintLogin() {
  const demo = [{ label: 'Owner · Suresh', phone: OWNER.phone }, ...staff.filter((x) => x.active).map((x) => ({ label: `Employee · ${x.name}`, phone: x.phone }))];
  $('#auth').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="auth-brand"><span class="mark-glyph" aria-hidden="true">${GLYPH}</span><div><b>Kleen<span class="wm-bay">Bay</span></b><small>${BUSINESS}</small></div></div>
    ${login.step === 'phone' ? `
      <h1>Sign in</h1>
      <p class="muted">Use the mobile number your car wash has registered.</p>
      <form id="loginPhone" class="grid" novalidate>
        <div class="field${login.err ? ' invalid' : ''}"><label class="label" for="loginNum">Mobile number</label>
          <span class="prefix"><span>+91</span><input class="input" id="loginNum" inputmode="tel" autocomplete="tel-national" placeholder="98470 00000" value="${esc(login.phone ? `${login.phone.slice(0, 5)} ${login.phone.slice(5)}` : '')}"></span>
          <p class="err" role="alert">${esc(login.err)}</p></div>
        <button class="btn primary lg block" type="submit">Send code</button>
      </form>
      <div class="demo"><p class="dim">Prototype accounts — tap one to fill the number</p>
        <div class="demo-list">${demo.map((d) => `<button type="button" data-demo="${d.phone}">${esc(d.label)}<small class="mono">${fmtPhone(d.phone)}</small></button>`).join('')}</div></div>`
    : `
      <h1>Enter your code</h1>
      <p class="muted">We sent a 6-digit code to <b class="mono">${fmtPhone(login.phone)}</b>.</p>
      <div class="notice">Prototype: no SMS is sent. Use code <b class="mono">${DEMO_OTP}</b></div>
      <form id="loginCode" class="grid" novalidate>
        <div class="field${login.err ? ' invalid' : ''}"><label class="label" for="otp">Code</label>
          <input class="input otp mono" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
          <p class="err" role="alert">${esc(login.err)}</p></div>
        <button class="btn primary lg block" type="submit">Verify and sign in</button>
        <button class="btn block" type="button" data-login-back>Use a different number</button>
      </form>`}
  </div></div>`;
  const first = $('#loginNum') || $('#otp');
  first?.focus();
  $('#loginPhone')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const phone = normPhone($('#loginNum').value);
    if (!phone) { login.err = 'Enter a valid 10-digit mobile number'; login.phone = ''; return paintLogin(); }
    login.phone = phone;
    const person = phone === OWNER.phone ? OWNER : staff.find((x) => x.phone === phone);
    if (!person) { login.err = 'This number is not registered. Ask the owner to add you under Team.'; return paintLogin(); }
    if (person.role !== 'OWNER' && !person.active) { login.err = 'Your access has been removed. Please contact the owner.'; return paintLogin(); }
    login = { step: 'code', phone, code: DEMO_OTP, user: person, tries: 0, err: '' };
    paintLogin();
  });
  $('#loginCode')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = $('#otp').value.replace(/\D/g, '');
    if (typed === login.code) return signIn(login.user);
    login.tries++;
    if (login.tries >= 5) { login = { step: 'phone', phone: login.phone, code: '', user: null, tries: 0, err: 'Too many wrong codes. Request a new one.' }; return paintLogin(); }
    login.err = typed.length < 6 ? 'Enter all 6 digits' : `That code is not right. ${5 - login.tries} tries left.`;
    paintLogin();
  });
}

/* ---------------------------------------------------------------- team (owner) */
function paintTeam() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const events = allEvents().filter((e) => e.at >= start.getTime());
  const count = (name) => events.filter((e) => e.by === name).length;
  const list = staff.slice().sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const invite = (x) => `https://wa.me/91${x.phone}?text=${encodeURIComponent(`Hi ${x.name}, you have been added to ${BUSINESS} on KleenBay. Open the app and sign in with your mobile number ${fmtPhone(x.phone)}.`)}`;
  view.innerHTML = `<div class="grid two">
    <section class="panel"><div class="panel-head"><h2>Add employee</h2></div>
      <form id="addStaff" class="grid" novalidate>
        <div class="field" id="f-sname"><label class="label" for="sname">Name</label><input class="input" id="sname" autocomplete="off" autocapitalize="words" maxlength="40" placeholder="Employee name"><p class="err"></p></div>
        <div class="field" id="f-sphone"><label class="label" for="sphone">Mobile number</label><span class="prefix"><span>+91</span><input class="input" id="sphone" inputmode="tel" autocomplete="off" placeholder="98470 00000"></span><p class="err"></p></div>
        <button class="btn primary block" type="submit">Add employee</button>
      </form></section>
    <section class="panel"><div class="panel-head"><h2>What employees can do</h2></div>
      <ul class="rules">
        <li class="yes">Check in new vehicles</li><li class="yes">Move cars between wash stages</li><li class="yes">Add before and after photos</li>
        <li class="no">See prices, payments or the daily summary</li><li class="no">Change wash types or the team</li>
      </ul>
      <p class="dim small">They sign in with their mobile number and a one-time code.</p></section>
    <section class="panel wide"><div class="panel-head"><h2>Employees</h2><span class="chip">${staff.filter((x) => x.active).length} active</span></div>
      <div class="people">${list.map((x) => `<div class="person${x.active ? '' : ' off'}">
        <span class="avatar" aria-hidden="true">${esc(x.name[0])}</span>
        <div class="person-main"><b>${esc(x.name)}</b><span class="mono dim">${fmtPhone(x.phone)}</span>
          <span class="person-meta">${x.active ? '<span class="chip ok">Active</span>' : '<span class="chip">Access removed</span>'}
            <span class="chip">${count(x.name)} updates today</span>
            <span class="dim">${x.lastLoginAt ? `Last sign-in ${fmtDay(x.lastLoginAt)}, ${fmtTime(x.lastLoginAt)}` : 'Not signed in yet'}</span></span></div>
        <div class="person-actions">
          ${x.active ? `<a class="btn" href="${invite(x)}" target="_blank" rel="noopener noreferrer">Send invite</a><button class="btn danger" data-staff-remove="${x.id}">Remove</button>`
            : `<button class="btn" data-staff-restore="${x.id}">Restore access</button>`}
        </div></div>`).join('') || '<div class="empty">No employees yet. Add one above.</div>'}</div></section>
  </div>`;

  const setErr = (id, msg) => { const el = document.getElementById(id); el.classList.toggle('invalid', !!msg); $('.err', el).textContent = msg || ''; };
  $('#addStaff').addEventListener('input', (e) => setErr(e.target.id === 'sname' ? 'f-sname' : 'f-sphone', ''));
  $('#addStaff').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#sname').value.trim().replace(/\s+/g, ' ');
    const phone = normPhone($('#sphone').value);
    let bad = false;
    if (!name) { setErr('f-sname', 'Enter the employee name'); bad = true; }
    if (!phone) { setErr('f-sphone', 'Enter a valid 10-digit mobile number'); bad = true; }
    else if (phone === OWNER.phone) { setErr('f-sphone', 'This is the owner number'); bad = true; }
    else {
      const existing = staff.find((x) => x.phone === phone);
      if (existing?.active) { setErr('f-sphone', `Already added as ${existing.name}`); bad = true; }
      else if (existing) { setErr('f-sphone', `This number belonged to ${existing.name}. Use Restore access below.`); bad = true; }
    }
    if (bad) return;
    staff.push({ id: 'st-' + Date.now().toString(36), name, phone, active: true, addedAt: Date.now(), lastLoginAt: null });
    toast(`${name} added`, `They can sign in with ${fmtPhone(phone)}`);
    refresh();
  });
}
function openRemoveStaff(id) {
  const x = staff.find((s) => s.id === id);
  openSheet(`<h2>Remove ${esc(x.name)}'s access?</h2>
    <p class="muted">They will be signed out and cannot sign in again. Their past updates stay in your records.</p>
    <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn danger" data-staff-remove-confirm="${x.id}">Remove access</button></div>`);
}

/* ---------------------------------------------------------------- wash types (owner) */
function paintServices() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const used = (id) => jobs.some((j) => j.service === id);
  const today = (id) => jobs.filter((j) => j.service === id && j.receivedAt >= start.getTime()).length;
  const list = SERVICES.slice().sort((a, b) => Number(b.active) - Number(a.active));
  view.innerHTML = `
    <div class="board-bar"><button class="btn primary" data-svc-add>${ICON.plus}Add wash type</button><span class="dim">${SERVICES.filter((x) => x.active).length} shown at check-in</span></div>
    <div class="svc-grid">${list.map((x) => `<article class="svc${x.active ? '' : ' off'}">
      <div class="svc-top"><b>${esc(x.name)}</b>${x.active ? '<span class="chip ok">Shown</span>' : '<span class="chip">Hidden</span>'}</div>
      <div class="svc-price mono">${inr(x.price)}</div>
      <div class="dim">${fmtMins(x.mins)} · ${today(x.id)} today</div>
      <div class="svc-actions">
        <button class="btn" data-svc-edit="${x.id}">Edit</button>
        <button class="btn" data-svc-toggle="${x.id}">${x.active ? 'Hide' : 'Show'}</button>
        ${used(x.id) ? '' : `<button class="btn danger" data-svc-delete="${x.id}">Delete</button>`}
      </div></article>`).join('')}</div>
    <p class="dim small" style="margin-top:var(--s4)">Hidden wash types stay on past jobs but are not offered at check-in. Price changes apply to new check-ins only.</p>`;
}
function openServiceSheet(id) {
  const x = id ? SERVICES.find((s) => s.id === id) : null;
  openSheet(`<h2>${x ? 'Edit wash type' : 'Add wash type'}</h2>
    <form id="svcForm" class="grid" novalidate style="margin-top:var(--s3)">
      <div class="field" id="f-vname"><label class="label" for="vname">Name</label><input class="input" id="vname" maxlength="40" placeholder="Foam wash" value="${esc(x?.name || '')}"><p class="err"></p></div>
      <div class="row2">
        <div class="field" id="f-vprice"><label class="label" for="vprice">Price (₹)</label><input class="input mono" id="vprice" inputmode="numeric" placeholder="399" value="${x ? x.price : ''}"><p class="err"></p></div>
        <div class="field" id="f-vmins"><label class="label" for="vmins">Time (minutes)</label><input class="input mono" id="vmins" inputmode="numeric" placeholder="30" value="${x ? x.mins : ''}"><p class="err"></p></div>
      </div>
      <div class="sheet-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${x ? 'Save changes' : 'Add wash type'}</button></div>
    </form>`, () => {
    const setErr = (fid, msg) => { const el = document.getElementById(fid); el.classList.toggle('invalid', !!msg); $('.err', el).textContent = msg || ''; };
    $('#vname').focus();
    $('#svcForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#vname').value.trim().replace(/\s+/g, ' ');
      const price = Number($('#vprice').value.replace(/[^\d]/g, '') || NaN);
      const mins = Number($('#vmins').value.replace(/[^\d]/g, '') || NaN);
      let bad = false;
      ['f-vname', 'f-vprice', 'f-vmins'].forEach((f) => setErr(f, ''));
      if (!name) { setErr('f-vname', 'Enter a name'); bad = true; }
      else if (SERVICES.some((s) => s.id !== x?.id && s.name.toLowerCase() === name.toLowerCase())) { setErr('f-vname', 'A wash type with this name already exists'); bad = true; }
      if (!Number.isFinite(price) || price > 100000) { setErr('f-vprice', 'Enter a price up to ₹1,00,000'); bad = true; }
      if (!Number.isFinite(mins) || mins < 5 || mins > 600) { setErr('f-vmins', 'Between 5 and 600 minutes'); bad = true; }
      if (bad) return;
      if (x) Object.assign(x, { name, price, mins });
      else SERVICES.push({ id: 'svc-' + Date.now().toString(36), name, price, mins, active: true });
      closeSheet();
      toast(x ? 'Wash type updated' : `${name} added`, x ? 'New price applies to new check-ins' : 'Now shown at check-in');
      refresh();
    });
  });
}
function toggleService(id) {
  const x = SERVICES.find((s) => s.id === id);
  if (x.active && SERVICES.filter((s) => s.active).length === 1) return toast('Keep at least one wash type', 'Check-in needs something to choose');
  x.active = !x.active;
  toast(`${x.name} ${x.active ? 'shown' : 'hidden'}`, x.active ? 'Available at check-in' : 'No longer offered at check-in');
  refresh();
}
function deleteService(id) {
  const x = SERVICES.find((s) => s.id === id);
  if (jobs.some((j) => j.service === id)) return toast('Cannot delete', 'It is used on jobs. Hide it instead.');
  if (x.active && SERVICES.filter((s) => s.active).length === 1) return toast('Keep at least one wash type');
  if (!confirm(`Delete ${x.name}?`)) return;
  SERVICES = SERVICES.filter((s) => s.id !== id);
  toast(`${x.name} deleted`);
  refresh();
}

/* ---------------------------------------------------------------- more (mobile menu) */
function paintMore() {
  const links = isOwner() ? [['history', 'History', 'Delivered today'], ['team', 'Team', 'Add or remove employees'], ['services', 'Wash types', 'Names, prices and times']] : [];
  view.innerHTML = `<div class="grid" style="max-width:560px">
    <section class="panel person-card"><span class="avatar lg" aria-hidden="true">${esc(session.name[0])}</span>
      <div><b>${esc(session.name)}</b><div class="dim mono">${fmtPhone(session.phone)}</div><span class="chip ${isOwner() ? 'money' : 'accent'}">${isOwner() ? 'Owner' : 'Employee'}</span></div></section>
    ${links.length ? `<section class="panel menu">${links.map(([n, t, d]) => `<a href="#/${n}">${NAV_ICON[n]}<span><b>${t}</b><small>${d}</small></span><i aria-hidden="true">›</i></a>`).join('')}</section>` : ''}
    <section class="panel menu">
      <button class="theme-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13.5A8.5 8.5 0 0 1 10.5 4a8.5 8.5 0 1 0 9.5 9.5Z"/></svg><span><b>Theme</b><small>Switch between sky and charcoal</small></span><i aria-hidden="true">›</i></button>
      ${isOwner() ? `<button data-reset-demo>${NAV_ICON.history}<span><b>Reset demo data</b><small>Start again with the sample cars</small></span><i aria-hidden="true">›</i></button>` : ''}
      <button data-signout class="menu-danger">${'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/></svg>'}<span><b>Sign out</b><small>${esc(session.name)}</small></span></button>
    </section></div>`;
}

/* ---------------------------------------------------------------- portal events */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-demo],[data-login-back],[data-signout],[data-feed],[data-staff-remove],[data-staff-remove-confirm],[data-staff-restore],[data-svc-add],[data-svc-edit],[data-svc-toggle],[data-svc-delete],[data-reset-demo]');
  if (!t) return;
  if (t.dataset.demo) { login.phone = t.dataset.demo; login.err = ''; paintLogin(); return; }
  if ('loginBack' in t.dataset) { login = { step: 'phone', phone: login.phone, code: '', user: null, tries: 0, err: '' }; return paintLogin(); }
  if ('signout' in t.dataset) return signOut('Signed out');
  if (t.dataset.feed) { feedFilter = t.dataset.feed; return paintActivity(); }
  if (t.dataset.staffRemove) return openRemoveStaff(t.dataset.staffRemove);
  if (t.dataset.staffRemoveConfirm) {
    const x = staff.find((s) => s.id === t.dataset.staffRemoveConfirm);
    x.active = false;
    closeSheet();
    toast(`${x.name}'s access removed`, 'Signed out everywhere');
    return refresh();
  }
  if (t.dataset.staffRestore) {
    const x = staff.find((s) => s.id === t.dataset.staffRestore);
    x.active = true;
    toast(`${x.name} can sign in again`);
    return refresh();
  }
  if ('svcAdd' in t.dataset) return openServiceSheet(null);
  if (t.dataset.svcEdit) return openServiceSheet(t.dataset.svcEdit);
  if (t.dataset.svcToggle) return toggleService(t.dataset.svcToggle);
  if (t.dataset.svcDelete) return deleteService(t.dataset.svcDelete);
  if ('resetDemo' in t.dataset) {
    if (!confirm('Reset all demo data? Your changes will be lost.')) return;
    seedDemo();
    report.sent = []; report.closedAt = null;
    SERVICES = SERVICES.filter((x) => ['basic', 'premium', 'exterior', 'interior', 'detail'].includes(x.id)).map((x) => ({ ...x, active: true }));
    saveDb();
    toast('Demo data reset');
    location.hash = '#/board';
  }
});

// Live updates between portals (another tab changed the shared data).
addEventListener('storage', (e) => {
  if (e.key !== STORE || !e.newValue) return;
  const before = latestEventAt();
  try { applySnapshot(e.newValue); } catch { return; }
  if (session && !validSession(session)) return signOut('Your access was removed by the owner');
  if (!session) return;
  const fresh = allEvents().filter((ev) => ev.at > before && ev.by !== me());
  if (fresh.length) {
    const f = fresh[0];
    toast(eventText(f),
      fresh.length > 1 ? `+${fresh.length - 1} more update${fresh.length > 2 ? 's' : ''}` : `${fmtTime(f.at)} · live update`);
  }
  const typing = view.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (typing || $('#scrim')) paintNav(route().name);
  else refresh();
});


/* ---------------------------------------------------------------- drag and drop */
const drag = { pending: null, active: null, muteClickUntil: 0 };
const dropRule = (j, target) => {
  const i = FLOW.indexOf(j.status), t = FLOW.indexOf(target);
  return t === i ? 'current' : t === i + 1 ? 'next' : t === i - 1 ? 'back' : 'no';
};
const dropClass = (j, t) => ({ current: '', next: 'drop-ok', back: 'drop-ok', no: 'drop-no' }[dropRule(j, t)]);

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag.active || !['board', 'stage', 'find'].includes(route().name)) return;
  const card = e.target.closest('.job');
  if (!card || e.target.closest('.act')) return;
  const p = { id: card.dataset.card, el: card, x: e.clientX, y: e.clientY, pointerId: e.pointerId, type: e.pointerType, timer: null };
  if (p.type !== 'mouse') p.timer = setTimeout(() => startDrag(p, p.x, p.y), 350);
  drag.pending = p;
});
document.addEventListener('pointermove', (e) => {
  if (drag.active) { if (e.pointerId === drag.active.pointerId) moveDrag(e.clientX, e.clientY); return; }
  const p = drag.pending;
  if (!p || e.pointerId !== p.pointerId) return;
  const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
  if (p.type === 'mouse') { if (dist > 6) startDrag(p, e.clientX, e.clientY); }
  else if (dist > 10) cancelPending();
});
document.addEventListener('pointerup', (e) => {
  if (drag.active && e.pointerId === drag.active.pointerId) endDrag(e.clientX, e.clientY);
  else cancelPending();
});
document.addEventListener('pointercancel', () => { cancelPending(); cleanupDrag(); });
document.addEventListener('touchmove', (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (drag.pending || drag.active) e.preventDefault(); });
function cancelPending() { if (drag.pending) clearTimeout(drag.pending.timer); drag.pending = null; }

function startDrag(p, x, y) {
  cancelPending();
  const j = byId(p.id);
  if (!j || !document.body.contains(p.el)) return;
  const r = p.el.getBoundingClientRect();
  let ghost, dx, dy;
  if (p.type === 'mouse') {
    ghost = p.el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    dx = p.x - r.left; dy = p.y - r.top;
  } else {
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost drag-ghost-chip';
    ghost.style.setProperty('--stage', STAGE[j.status].tone);
    ghost.textContent = fmtPlate(j.plate);
    document.body.appendChild(ghost);
    dx = ghost.offsetWidth / 2; dy = ghost.offsetHeight + 56;
  }
  document.body.appendChild(ghost);
  drag.active = { ...p, job: j, ghost, dx, dy, over: null, travel: 0 };
  p.el.classList.add('drag-src');
  document.body.classList.add('dragging');
  $('#toast').hidden = true;
  if (p.type !== 'mouse') {
    // Touch: a car can only go one step either way, so show just those two targets, as big as possible.
    // Back sits on the left and forward on the right, the direction the car travels.
    const i = FLOW.indexOf(j.status);
    const back = i > 0 ? FLOW[i - 1] : null, next = FLOW[i + 1];
    const zone = (st, dir) => `<div class="big-drop ${dir}" data-drop="${st}" style="--stage:${STAGE[st].tone}">
        ${ARROW}<small>${dir === 'back' ? 'Move back to' : st === 'DELIVERED' ? 'Hand over' : 'Move to'}</small><b>${STAGE[st].label}</b></div>`;
    $('#tray').innerHTML = `<div class="tray-title">Drag onto a stage · let go anywhere else to cancel</div>
      <div class="big-drops${back ? '' : ' single'}">${back ? zone(back, 'back') : ''}${zone(next, 'next')}</div>`;
    $('#tray').classList.add('big');
  } else {
    const hint = { current: 'current', next: 'move here', back: 'move back', no: 'not allowed' };
    $('#tray').innerHTML = `<div class="tray-title">Drop ${esc(fmtPlate(j.plate))} on a stage</div><div class="tray-grid">${FLOW.map((s) =>
      `<div class="drop ${dropClass(j, s)}" data-drop="${s}" style="--stage:${STAGE[s].tone}"><b>${STAGE[s].short}</b>${hint[dropRule(j, s)]}</div>`).join('')}</div>`;
    $('#tray').classList.remove('big');
  }
  $('#tray').hidden = false;
  $$('.col[data-drop]').forEach((c) => {
    const cls = dropClass(j, c.dataset.drop); // the current stage gets no class
    if (cls) c.classList.add(cls);
  });
  if (p.type !== 'mouse') navigator.vibrate?.(12);
  moveDrag(x, y);
}
function moveDrag(x, y) {
  const d = drag.active;
  d.travel = Math.max(d.travel, Math.hypot(x - d.x, y - d.y));
  d.ghost.style.transform = `translate(${x - d.dx}px, ${y - d.dy}px) rotate(1.5deg)`;
  const target = document.elementFromPoint(x, y)?.closest('[data-drop]') || null;
  if (d.over !== target) {
    d.over?.classList.remove('over');
    target?.classList.add('over');
    d.over = target;
    // The finger hides the target, so the floating label above it says where the car will go.
    if (d.type !== 'mouse') {
      const dest = target?.classList.contains('big-drop') ? target.dataset.drop : null;
      d.ghost.textContent = dest ? `${fmtPlate(d.job.plate)} → ${STAGE[dest].col}` : fmtPlate(d.job.plate);
      d.ghost.classList.toggle('is-over', !!dest);
      d.dx = d.ghost.offsetWidth / 2; // stay centred above the finger as the label grows
      d.ghost.style.transform = `translate(${x - d.dx}px, ${y - d.dy}px) rotate(1.5deg)`;
      if (dest) navigator.vibrate?.(10);
    }
  }
}
function endDrag(x, y) {
  moveDrag(x, y);
  const { job, over, travel, type } = drag.active;
  const target = over?.dataset.drop;
  cleanupDrag();
  drag.muteClickUntil = Date.now() + 500;
  // pressed and held, then let go without really dragging: offer the stages as big buttons instead
  // (the finger is still over the car's own stage list, so ignore that as a drop target)
  if (type !== 'mouse' && travel < 14) return openMoveSheet(job);
  if (!target) return;
  const rule = dropRule(job, target);
  if (rule === 'next') advance(job.id);
  else if (rule === 'back') stepBack(job.id);
  else if (rule === 'no') toast('One stage at a time', `${fmtPlate(job.plate)} can't jump from ${STAGE[job.status].label} to ${STAGE[target].label}`);
}
function cleanupDrag() {
  const d = drag.active;
  if (!d) return;
  d.ghost.remove();
  d.el.classList.remove('drag-src');
  document.body.classList.remove('dragging');
  $('#tray').hidden = true;
  $('#tray').innerHTML = '';
  $('#tray').classList.remove('big');
  $$('.col[data-drop]').forEach((c) => c.classList.remove('drop-ok', 'drop-no', 'over'));
  drag.active = null;
}

/* ---------------------------------------------------------------- events */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-next],[data-open],[data-group],[data-close],[data-handover],[data-undo],[data-pay],[data-clear-search],[data-pad],[data-shot-add],[data-shot-view],[data-draft-remove],[data-lb-prev],[data-lb-next],[data-lb-close],[data-lb-delete],[data-send],[data-send-confirm],[data-copy],[data-csv],.theme-btn,#searchBtn');
  if (!t) return;

  if (t.dataset.next) return advance(t.dataset.next);
  if (t.dataset.open) { if (Date.now() > drag.muteClickUntil) location.hash = `#/job/${t.dataset.open}`; return; }
  if (t.dataset.group) { ui.group = t.dataset.group; paintBoard(); return; }
  if ('clearSearch' in t.dataset) { ui.query = ''; paintBoard(); return; }
  if (t.dataset.handover) {
    const pay = $('#sheet input[name="pay"]:checked')?.value;
    if (!pay) { $('#payErr').textContent = 'Choose how the customer paid'; return; }
    const id = t.dataset.handover;
    closeSheet();
    return step(id, pay);
  }
  if ('close' in t.dataset) return closeSheet();
  if ('undo' in t.dataset) { $('#toast').hidden = true; return runUndo(); }
  if (t.dataset.pay) { const [id, m] = t.dataset.pay.split('|'); return markPaid(id, m); }
  if (t.dataset.pad) {
    const k = t.dataset.pad;
    if (k === 'done') { location.hash = '#/board'; return; }
    ui.query = k === 'clear' ? ui.query.slice(0, -1) : (ui.query + k).slice(0, 4);
    return paintFind();
  }
  if (t.dataset.shotAdd) {
    if (t.getAttribute('aria-busy') === 'true') return;
    const [jobId, kind] = t.dataset.shotAdd.split('|');
    const files = await pickFiles();
    if (jobId === 'draft') return addShots(files, kind, draftPhotos, renderDraftShots, t);
    const j = byId(jobId);
    return addShots(files, kind, j.photos, () => { if ($('#scrim')) openHandover(j); refresh(); }, t);
  }
  if (t.dataset.shotView) { const [id, kind, i] = t.dataset.shotView.split('|'); return openLightbox(id, kind, Number(i)); }
  if (t.dataset.draftRemove) {
    const [gone] = draftPhotos.splice(Number(t.dataset.draftRemove), 1);
    if (gone) URL.revokeObjectURL(gone.url);
    return renderDraftShots();
  }
  if ('lbPrev' in t.dataset) return stepLightbox(-1);
  if ('lbNext' in t.dataset) return stepLightbox(1);
  if ('lbClose' in t.dataset) return closeLightbox();
  if ('lbDelete' in t.dataset) return deleteShot();
  if ('send' in t.dataset) return openSend();
  if ('sendConfirm' in t.dataset) return sendSummary();
  if ('csv' in t.dataset) return exportCsv();
  if ('copy' in t.dataset) {
    try { await navigator.clipboard.writeText($('#waText').textContent); toast('Summary copied'); }
    catch { toast('Could not copy', 'Select the text instead'); }
    return;
  }
  if (t.classList.contains('theme-btn')) return setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  if (t.id === 'searchBtn') { ui.query = ''; location.hash = '#/find'; }
});
document.addEventListener('change', (e) => {
  const id = e.target.dataset?.recipient;
  if (!id) return;
  if (e.target.checked) report.recipients.add(id); else report.recipients.delete(id);
  writePref('recipients', [...report.recipients].join(','));
  const err = document.getElementById('recipErr');
  if (err) err.textContent = '';
});
document.addEventListener('keydown', (e) => {
  if (lb) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    return;
  }
  if (e.key === 'Escape') closeSheet();
  if (route().name === 'find' && /^[0-9]$/.test(e.key)) { ui.query = (ui.query + e.key).slice(0, 4); paintFind(); }
  if (route().name === 'find' && e.key === 'Backspace') { ui.query = ui.query.slice(0, -1); paintFind(); }
});

// keep ages fresh without disturbing anything the user is doing
setInterval(() => {
  if (!drag.active && !$('#scrim') && !lb && route().name === 'board') paintBoard();
}, 30000);

render();
