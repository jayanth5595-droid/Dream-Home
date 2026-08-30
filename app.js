/* =========================================================
   DREAM HOME v3 — APP.JS
   Public view + Owner-only editing + Supabase cloud sync
   ========================================================= */

const CFG = window.DREAM_HOME || {};

const READY =
  CFG.url &&
  !CFG.url.includes("PASTE_") &&
  CFG.key &&
  !CFG.key.includes("PASTE_");

const db = READY
  ? supabase.createClient(CFG.url, CFG.key)
  : null;

let user = null;
let loan = null;
let borrowers = [];
let paymentsData = [];

/* =========================================================
   HELPERS
   ========================================================= */

const $ = id => document.getElementById(id);

const money = value =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(Number(value) || 0));

const num = value => Number(value) || 0;

const esc = value =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function toast(message, type = "success") {
  const t = $("toast");

  if (!t) return;

  t.className = `toast ${type}`;
  t.textContent = message;
  t.style.display = "block";

  clearTimeout(window.toastTimer);

  window.toastTimer = setTimeout(() => {
    t.style.display = "none";
  }, 2500);
}

function syncStatus(status) {
  const el = $("sync");

  if (!el) return;

  el.className =
    status === "ok"
      ? "ok"
      : status === "bad"
      ? "bad"
      : "";

  el.title =
    status === "ok"
      ? "Cloud synchronized"
      : status === "bad"
      ? "Cloud connection problem"
      : "Connecting...";
}

function isOwner() {
  return !!(
    user &&
    loan &&
    loan.created_by &&
    user.id === loan.created_by
  );
}

/* =========================================================
   INTEREST / EMI
   ========================================================= */

function monthlyRate() {
  return num(loan?.annual_rate) / 1200;
}

/*
  Minimum EMI is ALWAYS calculated from:
  Total loan + annual interest + original tenure.
*/
function minimumEMI() {
  if (!loan) return 0;

  const principal = num(loan.total_amount);
  const months = num(loan.tenure_months);
  const r = monthlyRate();

  if (!principal || !months) return 0;

  if (!r) return principal / months;

  return (
    principal *
    r *
    Math.pow(1 + r, months) /
    (Math.pow(1 + r, months) - 1)
  );
}

/*
  Fixed EMI = sum of all people's fixed EMIs.
*/
function fixedEMI() {
  return borrowers.reduce(
    (sum, b) => sum + num(b.scheduled_emi),
    0
  );
}

/* =========================================================
   EMI MONTHS
   ========================================================= */

function firstEMIDate() {
  if (!loan?.start_date) return null;

  const d = new Date(`${loan.start_date}T00:00:00`);

  /*
    Loan taken in August
    EMI starts in September.
  */
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);

  return d;
}

function monthLabel(date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric"
  });
}

function emiMonths() {
  if (!loan) return [];

  const start = firstEMIDate();

  if (!start) return [];

  const result = [];

  const total = num(loan.tenure_months);

  for (let i = 0; i < total; i++) {
    const d = new Date(start);
    d.setMonth(start.getMonth() + i);

    result.push({
      index: i + 1,
      label: monthLabel(d),
      date: d
    });
  }

  return result;
}

/* =========================================================
   PAYMENT LOOKUP
   ========================================================= */

function getPayment(monthNo, borrowerId) {
  return (
    paymentsData.find(
      p =>
        num(p.month_no) === num(monthNo) &&
        p.borrower_id === borrowerId
    ) || {
      emi_paid: 0,
      extra_principal: 0
    }
  );
}

/* =========================================================
   LOAN CALCULATION
   =========================================================

   IMPORTANT RULE:

   - No principal-share calculation.
   - Loan is treated as ONE common loan.
   - Interest is calculated on total outstanding principal.
   - Fixed EMI contributions are tracked person-wise.
   - Extra principal is tracked person-wise.
   - Extra principal reduces the common outstanding principal.
   - Interest subsequently falls because the common principal falls.

   For contribution reporting, person payments are still tracked
   separately.
   ========================================================= */

function calculateLoan() {
  if (!loan) {
    return {
      balance: 0,
      principalPaid: 0,
      interestPaid: 0,
      extraPrincipal: 0,
      totalPaid: 0,
      monthsPaid: 0,
      monthsRemaining: num(loan?.tenure_months),
      actualTenure: num(loan?.tenure_months)
    };
  }

  let balance = num(loan.total_amount);

  let principalPaid = 0;
  let interestPaid = 0;
  let extraPrincipal = 0;
  let totalPaid = 0;

  const months = emiMonths();

  let monthsPaid = 0;

  for (const m of months) {
    const monthPayments = borrowers.map(b =>
      getPayment(m.index, b.id)
    );

    const emiPaid = monthPayments.reduce(
      (s, p) => s + num(p.emi_paid),
      0
    );

    const extra = monthPayments.reduce(
      (s, p) => s + num(p.extra_principal),
      0
    );

    const totalMonthPaid = emiPaid + extra;

    /*
      Once loan reaches zero, stop.
    */
    if (balance <= 0) break;

    const interestDue = balance * monthlyRate();

    /*
      Interest-only period.
    */
    const interestOnlyMonths =
      num(loan.interest_only_months);

    let principalFromEMI = 0;

    if (m.index > interestOnlyMonths) {
      principalFromEMI = Math.min(
        Math.max(0, emiPaid - interestDue),
        balance
      );
    }

    /*
      Extra principal always reduces common principal.
    */
    const extraUsed = Math.min(
      extra,
      Math.max(0, balance - principalFromEMI)
    );

    const actualPrincipal =
      principalFromEMI + extraUsed;

    const actualInterestPaid =
      Math.min(emiPaid, interestDue);

    balance = Math.max(
      0,
      balance - actualPrincipal
    );

    principalPaid += actualPrincipal;
    extraPrincipal += extraUsed;
    interestPaid += actualInterestPaid;
    totalPaid += totalMonthPaid;

    monthsPaid = m.index;

    if (balance <= 0) break;
  }

  /*
    Calculate remaining tenure using current balance and
    Minimum EMI.

    This is NOT simply original tenure - payments.
    Extra principal can shorten the tenure.
  */
  let projectedBalance = balance;
  let projectedMonths = 0;

  const minEMI = minimumEMI();
  const r = monthlyRate();

  if (projectedBalance > 0 && minEMI > 0) {
    while (
      projectedBalance > 0 &&
      projectedMonths < 1200
    ) {
      const interest = projectedBalance * r;

      let principal;

      if (!r) {
        principal = minEMI;
      } else {
        principal = minEMI - interest;
      }

      if (principal <= 0) break;

      projectedBalance -= Math.min(
        principal,
        projectedBalance
      );

      projectedMonths++;

      if (projectedBalance <= 0) break;
    }
  }

  return {
    balance,
    principalPaid,
    interestPaid,
    extraPrincipal,
    totalPaid,
    monthsPaid,
    monthsRemaining: projectedMonths,
    actualTenure: monthsPaid + projectedMonths
  };
}

/* =========================================================
   PERSON CALCULATION
   ========================================================= */

function personStats(borrower) {
  let emiPaid = 0;
  let extra = 0;
  let total = 0;

  paymentsData
    .filter(p => p.borrower_id === borrower.id)
    .forEach(p => {
      emiPaid += num(p.emi_paid);
      extra += num(p.extra_principal);
      total +=
        num(p.emi_paid) +
        num(p.extra_principal);
    });

  const allPaid = paymentsData.reduce(
    (s, p) =>
      s +
      num(p.emi_paid) +
      num(p.extra_principal),
    0
  );

  const contribution =
    allPaid > 0
      ? (total / allPaid) * 100
      : 0;

  return {
    emiPaid,
    extra,
    total,
    contribution
  };
}

/* =========================================================
   NAVIGATION
   ========================================================= */

function nav(screen) {
  document
    .querySelectorAll(".screen")
    .forEach(x => x.classList.remove("active"));

  const target = $(screen);

  if (target) {
    target.classList.add("active");
  }

  document
    .querySelectorAll("nav button")
    .forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.s === screen
      );
    });

  const titles = {
    dashboard: "Dashboard",
    payments: "Payments",
    people: "People",
    reports: "Reports",
    more: "More"
  };

  if ($("title")) {
    $("title").textContent =
      titles[screen] || "Dashboard";
  }

  if (screen === "dashboard") dashboard();
  if (screen === "payments") payments();
  if (screen === "people") people();
  if (screen === "reports") reports();
  if (screen === "more") more();
}

/* =========================================================
   LOAD CLOUD DATA
   ========================================================= */

async function load() {
  if (!db) {
    syncStatus("bad");
    dashboard();
    return;
  }

  syncStatus("");

  try {
    const authResult =
      await db.auth.getUser();

    user = authResult.data?.user || null;

    /*
      Public can read loan.
    */
    const loanResult = await db
      .from("loans")
      .select("*")
      .order("created_at", {
        ascending: true
      })
      .limit(1)
      .maybeSingle();

    if (loanResult.error) {
      console.error(loanResult.error);
      syncStatus("bad");
      toast(
        loanResult.error.message,
        "error"
      );
      return;
    }

    loan = loanResult.data;

    if (!loan) {
      borrowers = [];
      paymentsData = [];

      syncStatus("ok");
      dashboard();
      return;
    }

    const [bResult, pResult] =
      await Promise.all([
        db
          .from("borrowers")
          .select("*")
          .eq("loan_id", loan.id)
          .order("sort_order", {
            ascending: true
          }),

        db
          .from("monthly_payments")
          .select("*")
          .eq("loan_id", loan.id)
          .order("month_no", {
            ascending: true
          })
      ]);

    if (bResult.error)
      throw bResult.error;

    if (pResult.error)
      throw pResult.error;

    borrowers = bResult.data || [];
    paymentsData = pResult.data || [];

    syncStatus("ok");

    dashboard();
  } catch (error) {
    console.error(error);

    syncStatus("bad");

    toast(
      error.message || "Cloud connection failed",
      "error"
    );
  }
}

/* =========================================================
   DASHBOARD
   ========================================================= */

function dashboard() {
  const el = $("dashboard");

  if (!el) return;

  /*
    No loan yet.
  */
  if (!loan) {
    el.innerHTML = `
      <div class="hero">
        <small>DREAM HOME</small>
        <strong>Home Loan Tracker</strong>
        <div>
          Secure cloud tracking for your shared home loan.
        </div>
      </div>

      <div class="card">
        <div class="empty">
          <div style="font-size:42px">🏠</div>
          <h2>No loan created</h2>
          <p class="muted">
            Owner sign-in is required to create the loan.
          </p>
        </div>
      </div>
    `;

    return;
  }

  const stats = calculateLoan();

  const minimum = minimumEMI();
  const fixed = fixedEMI();

  const original =
    num(loan.total_amount);

  const paidPercent =
    original > 0
      ? ((original - stats.balance) /
          original) *
        100
      : 0;

  const originalTenure =
    num(loan.tenure_months);

  const paidEMIs =
    Math.min(
      originalTenure,
      stats.monthsPaid
    );

  const actualTenure =
    stats.balance <= 0
      ? paidEMIs
      : stats.actualTenure ||
        originalTenure;

  const progressPercent =
    originalTenure > 0
      ? Math.min(
          100,
          (paidEMIs /
            originalTenure) *
            100
        )
      : 0;

  el.innerHTML = `
    <div class="hero">
      <small>REMAINING PRINCIPAL</small>

      <strong>
        ${money(stats.balance)}
      </strong>

      <div>
        Original loan ${money(original)}
        · ${num(loan.annual_rate)}%
        · ${originalTenure} months
      </div>
    </div>

    <div class="metrics">

      <div class="metric">
        <small>Minimum EMI</small>
        <strong>${money(minimum)}</strong>
      </div>

      <div class="metric">
        <small>Fixed EMI</small>
        <strong>${money(fixed)}</strong>
      </div>

    </div>

    <div class="card emi-progress">

      <div class="pt">
        <div>
          <h2>EMI Progress</h2>

          <div class="muted">
            ${paidEMIs} of ${originalTenure} EMIs
          </div>
        </div>

        <span class="pill">
          ${actualTenure} months
        </span>
      </div>

      <div class="progress-track">
        <i
          style="width:${Math.max(
            0,
            Math.min(100, progressPercent)
          )}%"
        ></i>
      </div>

      <div class="progress-bottom">
        <span>
          ${progressPercent.toFixed(1)}% completed
        </span>

        <span>
          ${actualTenure < originalTenure
            ? `New tenure: ${actualTenure} months`
            : `Original tenure: ${originalTenure} months`}
        </span>
      </div>

    </div>

    <div class="actions">

      ${
        isOwner()
          ? `
            <button
              class="btn primary"
              onclick="payment()"
            >
              ＋ Add Payment
            </button>

            <button
              class="btn soft"
              onclick="loanEdit()"
            >
              ⚙️ Loan Settings
            </button>
          `
          : ""
      }

    </div>
  `;
}

/* =========================================================
   PAYMENTS PAGE
   ========================================================= */

function payments() {
  const el = $("payments");

  if (!el) return;

  if (!loan) {
    el.innerHTML = `
      <div class="card empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  const months = emiMonths();

  /*
    Display only months that have payment records.
  */
  const savedMonths = [
    ...new Set(
      paymentsData.map(p =>
        num(p.month_no)
      )
    )
  ].sort((a, b) => b - a);

  let html = `
    <div class="card">

      <div class="pt">

        <div>
          <h2>Payments</h2>

          <div class="muted">
            Enter actual payment and extra principal.
          </div>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="btn primary"
                onclick="payment()"
              >
                ＋ Add
              </button>
            `
            : ""
        }

      </div>
  `;

  if (!savedMonths.length) {
    html += `
      <div class="empty">
        <div style="font-size:38px">💳</div>
        <b>No payments recorded</b>
        <div class="muted">
          ${
            isOwner()
              ? "Tap Add to enter the first EMI."
              : "Payments will appear here."
          }
        </div>
      </div>
    `;
  }

  savedMonths.forEach(monthNo => {
    const month = months.find(
      m => m.index === monthNo
    );

    const monthPayments =
      paymentsData.filter(
        p =>
          num(p.month_no) ===
          monthNo
      );

    const totalEMI =
      monthPayments.reduce(
        (s, p) =>
          s + num(p.emi_paid),
        0
      );

    const totalExtra =
      monthPayments.reduce(
        (s, p) =>
          s + num(p.extra_principal),
        0
      );

    html += `
      <div class="payment-month">

        <div class="pt">
          <div>
            <b>
              ${month
                ? month.label
                : `Month ${monthNo}`}
            </b>

            <div class="muted">
              EMI ${money(totalEMI)}
              · Extra ${money(totalExtra)}
            </div>
          </div>

          ${
            isOwner()
              ? `
                <button
                  class="btn soft"
                  onclick="payment(${monthNo})"
                >
                  Edit
                </button>
              `
              : ""
          }

        </div>

      </div>
    `;
  });

  html += `</div>`;

  el.innerHTML = html;
}

/* =========================================================
   PEOPLE PAGE
   ========================================================= */

function people() {
  const el = $("people");

  if (!el) return;

  if (!loan) {
    el.innerHTML = `
      <div class="card empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  let html = `
    <div class="card">

      <div class="pt">
        <div>
          <h2>People</h2>
          <div class="muted">
            Individual payment contribution
          </div>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="btn soft"
                onclick="person()"
              >
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

  `;

  borrowers.forEach(b => {
    const s = personStats(b);

    html += `
      <div class="person-card">

        <div class="person-header">

          <div class="avatar">
            ${esc(
              (b.name || "P")
                .charAt(0)
                .toUpperCase()
            )}
          </div>

          <div class="person-name">
            <b>${esc(b.name)}</b>

            <span>
              Fixed EMI ${money(
                b.scheduled_emi
              )}
            </span>
          </div>

          ${
            isOwner()
              ? `
                <button
                  class="btn soft"
                  onclick="person('${b.id}')"
                >
                  Edit
                </button>
              `
              : ""
          }

        </div>

        <div class="person-grid">

          <div>
            <small>EMI Paid</small>
            <strong>${money(
              s.emiPaid
            )}</strong>
          </div>

          <div>
            <small>Extra Principal</small>
            <strong>${money(
              s.extra
            )}</strong>
          </div>

          <div>
            <small>Total Paid</small>
            <strong>${money(
              s.total
            )}</strong>
          </div>

          <div>
            <small>Contribution</small>
            <strong>
              ${s.contribution.toFixed(1)}%
            </strong>
          </div>

        </div>

      </div>
    `;
  });

  if (!borrowers.length) {
    html += `
      <div class="empty">
        No people added.
      </div>
    `;
  }

  html += `</div>`;

  el.innerHTML = html;
}

/* =========================================================
   REPORTS
   ========================================================= */

function reports() {
  const el = $("reports");

  if (!el) return;

  if (!loan) {
    el.innerHTML = `
      <div class="card empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  const s = calculateLoan();

  const original =
    num(loan.total_amount);

  const paidPercent =
    original > 0
      ? ((original - s.balance) /
          original) *
        100
      : 0;

  let html = `
    <div class="card">

      <h2>Loan Summary</h2>

      <div class="summary-grid">

        <div>
          <small>Original Loan</small>
          <strong>
            ${money(original)}
          </strong>
        </div>

        <div>
          <small>Remaining Principal</small>
          <strong>
            ${money(s.balance)}
          </strong>
        </div>

        <div>
          <small>Principal Paid</small>
          <strong>
            ${money(s.principalPaid)}
          </strong>
        </div>

        <div>
          <small>Interest Paid</small>
          <strong>
            ${money(s.interestPaid)}
          </strong>
        </div>

        <div>
          <small>Extra Principal</small>
          <strong>
            ${money(s.extraPrincipal)}
          </strong>
        </div>

        <div>
          <small>Loan Paid</small>
          <strong>
            ${Math.max(
              0,
              Math.min(100, paidPercent)
            ).toFixed(1)}%
          </strong>
        </div>

        <div>
          <small>Minimum EMI</small>
          <strong>
            ${money(minimumEMI())}
          </strong>
        </div>

        <div>
          <small>Fixed EMI</small>
          <strong>
            ${money(fixedEMI())}
          </strong>
        </div>

      </div>

    </div>

    <div class="card">

      <h2>People</h2>

  `;

  borrowers.forEach(b => {
    const p = personStats(b);

    html += `
      <div class="report-person">

        <div class="pt">

          <div>
            <b>${esc(b.name)}</b>

            <div class="muted">
              Fixed EMI:
              ${money(b.scheduled_emi)}
            </div>
          </div>

          <span class="pill">
            ${p.contribution.toFixed(1)}%
          </span>

        </div>

        <div class="person-grid">

          <div>
            <small>EMI Paid</small>
            <strong>
              ${money(p.emiPaid)}
            </strong>
          </div>

          <div>
            <small>Extra Principal</small>
            <strong>
              ${money(p.extra)}
            </strong>
          </div>

          <div>
            <small>Total Paid</small>
            <strong>
              ${money(p.total)}
            </strong>
          </div>

          <div>
            <small>Payment Contribution</small>
            <strong>
              ${p.contribution.toFixed(1)}%
            </strong>
          </div>

        </div>

      </div>
    `;
  });

  html += `
    </div>
  `;

  el.innerHTML = html;
}

/* =========================================================
   MORE
   ========================================================= */

function more() {
  const el = $("more");

  if (!el) return;

  el.innerHTML = `
    <div class="card account-card">

      <div class="account-icon">
        👤
      </div>

      <h2>Account</h2>

      <p class="muted">
        ${
          user
            ? `Signed in as ${esc(
                user.email
              )}`
            : "Public view mode"
        }
      </p>

      ${
        user
          ? `
            <button
              class="btn soft"
              onclick="signOut()"
            >
              Sign out
            </button>
          `
          : `
            <button
              class="btn primary"
              onclick="auth()"
            >
              🔐 Owner sign in
            </button>
          `
      }

    </div>

    <div class="card">

      <h2>Cloud</h2>

      <div class="row">
        <span>Cloud synchronization</span>

        <span class="pill ${
          READY
            ? "green"
            : "orange"
        }">
          ${
            READY
              ? "Connected"
              : "Not configured"
          }
        </span>
      </div>

    </div>

    ${
      isOwner()
        ? `
          <div class="card">

            <h2>Owner Tools</h2>

            <div class="row">
              <b>Loan settings</b>

              <button
                class="btn soft"
                onclick="loanEdit()"
              >
                Open
              </button>
            </div>

            <div class="row">
              <b>Reset loan</b>

              <button
                class="btn danger"
                onclick="resetLoan()"
              >
                Reset
              </button>
            </div>

          </div>
        `
        : ""
    }
  `;
}

/* =========================================================
   ACCOUNT ICON
   ========================================================= */

const accountButton = $("account");

if (accountButton) {
  accountButton.onclick = () => {
    auth();
  };
}

/* =========================================================
   AUTH POPUP
   ========================================================= */

function modal(content) {
  const mb = $("mb");
  const modalEl = $("modal");

  if (!mb || !modalEl) return;

  mb.innerHTML = content;
  modalEl.classList.add("open");
}

function closeModal() {
  const modalEl = $("modal");

  if (modalEl) {
    modalEl.classList.remove("open");
  }
}

if ($("x")) {
  $("x").onclick = closeModal;
}

if ($("modal")) {
  $("modal").onclick = e => {
    if (e.target === $("modal")) {
      closeModal();
    }
  };
}

function auth() {
  /*
    If already logged in, clicking the person icon
    must show SIGN OUT, not sign-in.
  */
  if (user) {
    modal(`
      <div class="auth-icon">👤</div>

      <h2>Owner Account</h2>

      <p class="muted">
        ${esc(user.email)}
      </p>

      <button
        class="btn danger full"
        onclick="signOut()"
      >
        Sign out
      </button>
    `);

    return;
  }

  modal(`
    <div class="auth-icon">🔐</div>

    <h2>Owner Sign In</h2>

    <p class="muted">
      Sign in to manage Dream Home.
      Public visitors can view the loan but cannot edit it.
    </p>

    <label>
      Email
      <input
        id="ae"
        type="email"
        placeholder="Owner email"
      >
    </label>

    <label>
      Password
      <input
        id="ap"
        type="password"
        placeholder="Password"
      >
    </label>

    <button
      class="btn primary full"
      onclick="login()"
    >
      Sign in
    </button>

    <button
      class="btn soft full"
      onclick="signup()"
    >
      Create owner account
    </button>
  `);
}

/* =========================================================
   LOGIN
   ========================================================= */

async function login() {
  if (!db) {
    toast(
      "Supabase is not configured.",
      "error"
    );
    return;
  }

  const email =
    $("ae")?.value.trim();

  const password =
    $("ap")?.value;

  if (!email || !password) {
    toast(
      "Enter email and password.",
      "error"
    );
    return;
  }

  const result =
    await db.auth.signInWithPassword({
      email,
      password
    });

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    "✓ Signed in successfully"
  );

  await load();
}

/* =========================================================
   SIGN UP
   ========================================================= */

async function signup() {
  if (!db) {
    toast(
      "Supabase is not configured.",
      "error"
    );
    return;
  }

  const email =
    $("ae")?.value.trim();

  const password =
    $("ap")?.value;

  if (!email || !password) {
    toast(
      "Enter email and password first.",
      "error"
    );
    return;
  }

  const result =
    await db.auth.signUp({
      email,
      password
    });

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    result.data?.session
      ? "✓ Owner account created"
      : "✓ Account created — check your email"
  );

  await load();
}

/* =========================================================
   SIGN OUT
   ========================================================= */

async function signOut() {
  if (!db) return;

  const result =
    await db.auth.signOut();

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  user = null;

  toast(
    "✓ Signed out successfully"
  );

  await load();
}

/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function loanEdit() {
  if (!isOwner()) {
    auth();
    return;
  }

  modal(`
    <h2>Loan Settings</h2>

    <div class="grid">

      <label class="full">
        Loan name
        <input
          id="ln"
          value="${esc(
            loan.name ||
              "Dream Home Loan"
          )}"
        >
      </label>

      <label>
        Total loan amount
        <input
          id="la"
          type="number"
          value="${num(
            loan.total_amount
          )}"
        >
      </label>

      <label>
        Annual interest %
        <input
          id="lr"
          type="number"
          step="0.01"
          value="${num(
            loan.annual_rate
          )}"
        >
      </label>

      <label>
        Tenure months
        <input
          id="lt"
          type="number"
          value="${num(
            loan.tenure_months
          )}"
        >
      </label>

      <label>
        Loan start date
        <input
          id="ls"
          type="date"
          value="${esc(
            loan.start_date
          )}"
        >
      </label>

      <label>
        Interest-only months
        <input
          id="li"
          type="number"
          min="0"
          value="${num(
            loan.interest_only_months
          )}"
        >
      </label>

    </div>

    <div class="info-box">
      <b>EMI calculation</b>

      <p>
        Minimum EMI is automatically calculated
        from loan amount, interest rate and tenure.
      </p>

      <p>
        Fixed EMI is the total of the fixed
        monthly EMI amounts assigned to all people.
      </p>

      <p>
        EMI starts one month after the loan start date.
      </p>
    </div>

    <button
      class="btn primary full"
      onclick="saveLoan()"
    >
      Save Loan Settings
    </button>
  `);
}

async function saveLoan() {
  if (!isOwner()) {
    auth();
    return;
  }

  const values = {
    name:
      $("ln")?.value.trim() ||
      "Dream Home Loan",

    total_amount:
      num($("la")?.value),

    annual_rate:
      num($("lr")?.value),

    tenure_months:
      num($("lt")?.value),

    start_date:
      $("ls")?.value,

    interest_only_months:
      num($("li")?.value),

    updated_at:
      new Date().toISOString()
  };

  if (
    !values.total_amount ||
    !values.tenure_months ||
    !values.start_date
  ) {
    toast(
      "Please complete all loan details.",
      "error"
    );
    return;
  }

  const result =
    await db
      .from("loans")
      .update(values)
      .eq("id", loan.id)
      .select()
      .single();

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  loan = result.data;

  closeModal();

  toast(
    "✓ Loan settings saved"
  );

  await load();
}

/* =========================================================
   PERSON
   ========================================================= */

function person(id) {
  if (!isOwner()) {
    auth();
    return;
  }

  const b =
    borrowers.find(
      x => x.id === id
    ) || {
      name: "",
      scheduled_emi: 0
    };

  modal(`
    <h2>
      ${id ? "Edit" : "Add"} Person
    </h2>

    <label>
      Name
      <input
        id="bn"
        value="${esc(
          b.name
        )}"
        placeholder="Person name"
      >
    </label>

    <label>
      Fixed Monthly EMI
      <input
        id="be"
        type="number"
        value="${num(
          b.scheduled_emi
        )}"
        placeholder="Fixed EMI"
      >
    </label>

    <button
      class="btn primary full"
      onclick="savePerson('${id || ""}')"
    >
      Save Person
    </button>

    ${
      id
        ? `
          <button
            class="btn danger full"
            onclick="deletePerson('${id}')"
          >
            Delete Person
          </button>
        `
        : ""
    }
  `);
}

async function savePerson(id) {
  if (!isOwner()) {
    auth();
    return;
  }

  const values = {
    loan_id: loan.id,
    name:
      $("bn")?.value.trim() ||
      "Person",

    scheduled_emi:
      num($("be")?.value),

    sort_order: id
      ? (
          borrowers.find(
            b => b.id === id
          )?.sort_order || 0
        )
      : borrowers.length
  };

  let result;

  if (id) {
    result =
      await db
        .from("borrowers")
        .update(values)
        .eq("id", id)
        .select()
        .single();
  } else {
    result =
      await db
        .from("borrowers")
        .insert(values)
        .select()
        .single();
  }

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    id
      ? "✓ Person updated"
      : "✓ Person added"
  );

  await load();
}

/* =========================================================
   DELETE PERSON
   ========================================================= */

async function deletePerson(id) {
  if (!isOwner()) {
    auth();
    return;
  }

  if (
    !confirm(
      "Delete this person and their payment records?"
    )
  ) {
    return;
  }

  const result =
    await db
      .from("borrowers")
      .delete()
      .eq("id", id);

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    "✓ Person deleted"
  );

  await load();
}

/* =========================================================
   PAYMENT ENTRY
   ========================================================= */

function payment(existingMonth) {
  if (!isOwner()) {
    auth();
    return;
  }

  const months = emiMonths();

  if (!months.length) {
    toast(
      "Set the loan start date first.",
      "error"
    );
    return;
  }

  /*
    If editing an existing month,
    use that month.

    Otherwise select the first unpaid month.
  */
  let selected =
    existingMonth ||
    months.find(m =>
      borrowers.some(b => {
        const p =
          getPayment(m.index, b.id);

        return (
          !num(p.emi_paid) &&
          !num(p.extra_principal)
        );
      })
    )?.index;

  if (!selected) {
    selected =
      months[months.length - 1].index;
  }

  showPaymentModal(selected);
}

/* =========================================================
   PAYMENT MODAL
   ========================================================= */

function showPaymentModal(monthNo) {
  const months = emiMonths();

  const month =
    months.find(
      m => m.index === monthNo
    );

  if (!month) return;

  let content = `
    <h2>
      ${month.label}
    </h2>

    <p class="muted">
      Enter only the actual EMI paid and
      extra principal paid by each person.
    </p>

    <div class="payment-selector">

      <label>
        EMI Month
        <select
          id="paymentMonth"
          onchange="changePaymentMonth()"
        >
  `;

  months.forEach(m => {
    content += `
      <option
        value="${m.index}"
        ${
          m.index === monthNo
            ? "selected"
            : ""
        }
      >
        ${m.label}
      </option>
    `;
  });

  content += `
        </select>
      </label>

    </div>

    <div id="paymentPeople"></div>

    <button
      class="btn primary full"
      onclick="savePayment()"
    >
      💾 Save Payment
    </button>
  `;

  modal(content);

  renderPaymentPeople(monthNo);
}

/* =========================================================
   CHANGE PAYMENT MONTH
   ========================================================= */

function changePaymentMonth() {
  const monthNo =
    num(
      $("paymentMonth")?.value
    );

  renderPaymentPeople(monthNo);
}

/* =========================================================
   PAYMENT PEOPLE
   ========================================================= */

function renderPaymentPeople(monthNo) {
  const container =
    $("paymentPeople");

  if (!container) return;

  container.innerHTML =
    borrowers
      .map(b => {
        const p =
          getPayment(
            monthNo,
            b.id
          );

        return `
          <div class="pay-card">

            <div class="pay-person">

              <div class="avatar">
                ${esc(
                  (b.name || "P")
                    .charAt(0)
                    .toUpperCase()
                )}
              </div>

              <div>
                <b>
                  ${esc(b.name)}
                </b>

                <div class="muted">
                  Fixed EMI:
                  ${money(
                    b.scheduled_emi
                  )}
                </div>
              </div>

            </div>

            <div class="grid">

              <label>
                EMI Paid
                <input
                  id="emi_${b.id}"
                  type="number"
                  value="${
                    num(p.emi_paid) ||
                    ""
                  }"
                  placeholder="${num(
                    b.scheduled_emi
                  )}"
                >
              </label>

              <label>
                Extra Principal
                <input
                  id="extra_${b.id}"
                  type="number"
                  value="${
                    num(
                      p.extra_principal
                    ) || ""
                  }"
                  placeholder="0"
                >
              </label>

            </div>

            <div class="calc">
              <span>
                Fixed EMI:
                <b>
                  ${money(
                    b.scheduled_emi
                  )}
                </b>
              </span>

              <span>
                Extra principal belongs to:
                <b>${esc(b.name)}</b>
              </span>
            </div>

          </div>
        `;
      })
      .join("");
}

/* =========================================================
   SAVE PAYMENT
   ========================================================= */

async function savePayment() {
  if (!isOwner()) {
    auth();
    return;
  }

  const monthNo =
    num(
      $("paymentMonth")?.value
    );

  if (!monthNo) {
    toast(
      "Select an EMI month.",
      "error"
    );
    return;
  }

  /*
    Save one row for each person.
  */
  for (const b of borrowers) {
    const emi =
      num(
        $(`emi_${b.id}`)?.value
      );

    const extra =
      num(
        $(`extra_${b.id}`)?.value
      );

    const values = {
      loan_id: loan.id,
      borrower_id: b.id,
      month_no: monthNo,
      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      emi_paid: emi,
      extra_principal: extra
    };

    const result =
      await db
        .from("monthly_payments")
        .upsert(
          values,
          {
            onConflict:
              "loan_id,borrower_id,month_no"
          }
        );

    if (result.error) {
      toast(
        result.error.message,
        "error"
      );
      return;
    }
  }

  closeModal();

  toast(
    "✓ Payment saved to cloud"
  );

  await load();
}

/* =========================================================
   RESET LOAN
   ========================================================= */

async function resetLoan() {
  if (!isOwner()) {
    auth();
    return;
  }

  const confirmation =
    prompt(
      "Type RESET to permanently delete the current loan and all payment records."
    );

  if (
    confirmation !== "RESET"
  ) {
    toast(
      "Reset cancelled.",
      "error"
    );
    return;
  }

  /*
    Delete payments first.
  */
  const p =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loan.id);

  if (p.error) {
    toast(
      p.error.message,
      "error"
    );
    return;
  }

  const b =
    await db
      .from("borrowers")
      .delete()
      .eq("loan_id", loan.id);

  if (b.error) {
    toast(
      b.error.message,
      "error"
    );
    return;
  }

  const l =
    await db
      .from("loans")
      .delete()
      .eq("id", loan.id);

  if (l.error) {
    toast(
      l.error.message,
      "error"
    );
    return;
  }

  loan = null;
  borrowers = [];
  paymentsData = [];

  closeModal();

  toast(
    "✓ Loan reset successfully"
  );

  await load();
}

/* =========================================================
   AUTH STATE
   ========================================================= */

if (db) {
  db.auth.onAuthStateChange(
    () => {
      setTimeout(
        () => load(),
        0
      );
    }
  );
}

/* =========================================================
   NAV BUTTONS
   ========================================================= */

document
  .querySelectorAll("nav button")
  .forEach(button => {
    button.onclick = () =>
      nav(
        button.dataset.s
      );
  });

/* =========================================================
   SERVICE WORKER
   ========================================================= */

if (
  "serviceWorker" in navigator
) {
  navigator.serviceWorker
    .register("./sw.js")
    .catch(error =>
      console.warn(
        "Service worker:",
        error
      )
    );
}

/* =========================================================
   START
   ========================================================= */

if (db) {
  load();
} else {
  dashboard();
}

nav("dashboard");
