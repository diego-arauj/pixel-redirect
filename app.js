const SUPABASE_URL =
  (window.CONFIG && window.CONFIG.SUPABASE_URL) ||
  "https://karohkskliddnzmufjag.supabase.co";
const SUPABASE_ANON_KEY =
  (window.CONFIG && window.CONFIG.SUPABASE_ANON_KEY) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imthcm9oa3NrbGlkZG56bXVmamFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2NjM0NjUsImV4cCI6MjA5MjIzOTQ2NX0.ce6mwGSZ7-ETVvzbSHs47vSX_WxmYurDg-pBpT1CUAE";
const SESSION_TTL_MINUTES = 30;

function getRouteParams(pathname, searchParams) {
  const queryAccountId = searchParams.get("account_id");
  const queryCampaignSlug = searchParams.get("campaign_slug");

  if (queryAccountId && queryCampaignSlug) {
    return {
      accountId: queryAccountId.trim(),
      campaignSlug: queryCampaignSlug.trim(),
    };
  }

  const segments = pathname.split("/").filter(Boolean);
  const rIndex = segments.indexOf("r");

  if (rIndex === -1 || !segments[rIndex + 1] || !segments[rIndex + 2]) {
    throw new Error("URL inválida. Esperado: /r/{account_id}/{campaign_slug}");
  }

  return {
    accountId: segments[rIndex + 1].trim(),
    campaignSlug: segments[rIndex + 2].trim(),
  };
}

function waitForFbp(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const match = document.cookie
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("_fbp="));
      if (match) {
        resolve(match.split("=")[1]);
      } else if (Date.now() - start >= timeoutMs) {
        resolve(null); // timeout — segue sem fbp
      } else {
        setTimeout(check, 100);
      }
    }
    check();
  });
}

function getTrackingParams(searchParams) {
  return {
    utm_source: searchParams.get("utm_source"),
    utm_medium: searchParams.get("utm_medium"),
    utm_campaign: searchParams.get("utm_campaign"),
    utm_content: searchParams.get("utm_content"),
    utm_term: searchParams.get("utm_term"),
    fbclid: searchParams.get("fbclid"),
  };
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toIsoString(date) {
  return date.toISOString();
}

function buildFbc(fbclid, clickedAt) {
  if (!fbclid) return null;

  const timestampMs = new Date(clickedAt).getTime();
  return `fb.1.${timestampMs}.${fbclid}`;
}

function assertSupabaseConfig() {
  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes("YOUR_PROJECT") ||
    SUPABASE_ANON_KEY.includes("YOUR_SUPABASE_ANON_KEY")
  ) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_ANON_KEY no window.");
  }
}

function buildRestUrl(table, query) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function getDefaultHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro ${response.status} em ${url}: ${errorText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;

  return response.json();
}

async function fetchAccountWhatsappNumber(accountId) {
  const url = buildRestUrl("accounts", {
    select: "whatsapp_number",
    id: `eq.${accountId}`,
    limit: "1",
  });

  const data = await fetchJson(url, {
    method: "GET",
    headers: getDefaultHeaders(),
  });

  const account = Array.isArray(data) ? data[0] : null;
  if (!account || !account.whatsapp_number) {
    throw new Error(`Conta não encontrada para account_id=${accountId}`);
  }

  return account.whatsapp_number;
}

async function fetchCampaign(accountId, campaignSlug) {
  const url = buildRestUrl("campaigns", {
    select: "id,account_id,slug",
    account_id: `eq.${accountId}`,
    slug: `eq.${campaignSlug}`,
    limit: "1",
  });

  const data = await fetchJson(url, {
    method: "GET",
    headers: getDefaultHeaders(),
  });

  const campaign = Array.isArray(data) ? data[0] : null;
  if (!campaign) {
    throw new Error(
      `Campanha não encontrada para account_id=${accountId} e campaign_slug=${campaignSlug}`
    );
  }

  return campaign;
}

function buildSessionPayload({
  accountId,
  campaign,
  tracking,
  clickedAt,
  expiresAt,
  fbc,
  fbp,
}) {
  return {
    account_id: accountId,
    campaign_id: campaign.id,
    utm_source: tracking.utm_source,
    utm_medium: tracking.utm_medium,
    utm_campaign: tracking.utm_campaign,
    utm_content: tracking.utm_content,
    utm_term: tracking.utm_term,
    fbclid: tracking.fbclid,
    fbp,
    fbc,
    clicked_at: clickedAt,
    expires_at: expiresAt,
    matched: false,
  };
}

async function insertSession(sessionPayload) {
  const url = buildRestUrl("sessions", {});

  await fetchJson(url, {
    method: "POST",
    headers: {
      ...getDefaultHeaders(),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(sessionPayload),
  });
}

function sanitizeWhatsappNumber(number) {
  return String(number).replace(/\D/g, "");
}

function redirectToWhatsapp(whatsappNumber) {
  const cleanNumber = sanitizeWhatsappNumber(whatsappNumber);
  if (!cleanNumber) throw new Error("whatsapp_number inválido");

  window.location.replace(`https://wa.me/${cleanNumber}`);
}

async function run() {
  const pixelId = window.CONFIG && window.CONFIG.META_PIXEL_ID;
  if (pixelId) {
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod
          ? n.callMethod.apply(n, arguments)
          : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(
      window,
      document,
      "script",
      "https://connect.facebook.net/en_US/fbevents.js"
    );
    fbq("init", pixelId);
    fbq("track", "PageView");
  }

  const fbp = await waitForFbp();

  assertSupabaseConfig();

  const url = new URL(window.location.href);
  const { accountId, campaignSlug } = getRouteParams(
    url.pathname,
    url.searchParams
  );
  const tracking = getTrackingParams(url.searchParams);

  const clickedAtDate = new Date();
  const expiresAtDate = addMinutes(clickedAtDate, SESSION_TTL_MINUTES);

  const clickedAt = toIsoString(clickedAtDate);
  const expiresAt = toIsoString(expiresAtDate);
  const fbc = buildFbc(tracking.fbclid, clickedAt);

  const whatsappNumber = await fetchAccountWhatsappNumber(accountId);
  const campaign = await fetchCampaign(accountId, campaignSlug);

  const sessionPayload = buildSessionPayload({
    accountId,
    campaign,
    tracking,
    clickedAt,
    expiresAt,
    fbc,
    fbp,
  });

  await insertSession(sessionPayload);
  redirectToWhatsapp(whatsappNumber);
}

run().catch((error) => {
  console.log("Falha no fluxo de redirecionamento:", error);
});
 
