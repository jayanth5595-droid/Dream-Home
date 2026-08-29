/* =========================================================
   DREAM HOME v3
   Loan tracker - public view / owner-only editing
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

const $ = id => document.getElementById(id);

const money = value =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(Number(value) || 0));

const number = value => Number(value) || 0;

const esc = value =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");


/* =========================================================
   TOAST / POPUPS
   ========================================================= */

function toast(message, type = "info") {
  const box = $("toast");
  if (!box) return;

  box.className = `toast ${type}`;
  box.innerHTML = `
    <div class="toast-icon">
      ${type === "success" ? "✓" : type === "error" ? "!" : "i"}
    </div>
    <div>${esc(message)}</div>
  `;

  box.style.display = "flex";

  clearTimeout(window.__toastTimer);

  window.__toastTimer = setTimeout(() => {
    box.style.display = "none";
  }, 2600);
}


function openModal(html) {
  const modal = $("modal");
  const body = $("mb");

  if (!modal || !body) return;

  body.innerHTML = html;
  modal.classList.add("open");
}


function closeModal() {
  const modal = $("modal");
  if (modal) modal.classList.remove("open");
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


/* =========================================================
   CLOUD STATUS
   ========================================================= */

function cloudStatus(state) {
  const dot = $("sync");
  if (!dot) return;

  dot.className = "";

  if (state === "ok") {
    dot.classList.add("ok");
    dot.title = "Cloud connected";
  } else if (state === "bad") {
    dot.classList.add("bad");
    dot.title = "Cloud connection error";
  } else {
    dot.title = "Connecting to cloud...";
  }
}


/* =========================================================
   AUTH
   ========================================================= */

function isOwner() {
  return !!(
    user &&
    loan &&
    loan.created_by &&
    loan.created_by === user.id
  );
}


function accountPopup() {
  if (!db) {
    openModal(`
      <div class="popup-head">
        <div class="popup-icon">☁</div>
        <div>
          <h2>Cloud not connected</h2>
          <p class="muted">
            Supabase connection is not configured correctly.
          </p>
        </div>
      </div>

      <button class="btn soft" onclick="closeModal()">
        Close
      </button>
    `);

    return;
  }

  if (user) {
    openModal(`
      <div class="popup-head">
        <div class="popup-icon">✓</div>
        <div>
          <h2>Owner account</h2>
          <p class="muted">${esc(user.email)}</p>
        </div>
      </div>

      <div class="account-status">
        <span class="status-dot"></span>
        Owner editing access enabled
      </div>

      <button class="btn danger" onclick="signOut()">
        Sign out
      </button>

      <button class="btn soft" onclick="closeModal()">
        Cancel
      </button>
    `);

    return;
  }

  openModal(`
    <div class="popup-head">
      <div class="popup-icon">🔐</div>
      <div>
        <h2>Owner access</h2>
        <p class="muted">
          Public users can view the loan.
          Only the owner can edit it.
        </p>
      </div>
    </div>

    <label>
      Email
      <input id="loginEmail" type="email"
             placeholder="Owner email">
    </label>

    <label>
      Password
      <input id="loginPassword" type="password"
             placeholder="Password">
    </label>

    <button class="btn primary" onclick="signIn()">
      Sign in
    </button>

    <button class="btn soft" onclick="createOwner()">
      Create owner account
    </button>
  `);
}


async function signIn() {
  if (!db) return;

  const email = $("loginEmail")?.value.trim();
  const password = $("loginPassword")?.value;

  if (!email || !password) {
    toast("Enter email and password.", "error");
    return;
  }

  const result = await db.auth.signInWithPassword({
    email,
    password
  });

  if (result.error) {
    toast(result.error.message, "error");
    return;
  }

  closeModal();

  toast("Welcome back. Owner access enabled.", "success");

  await load();
}


async function createOwner() {
  if (!db) return;

  const email = $("loginEmail")?.value.trim();
  const password = $("loginPassword")?.value;

  if (!email || !password) {
    toast("Enter email and password first.", "error");
    return;
  }

  if (password.length < 6) {
    toast("Password must contain at least 6 characters.", "error");
    return;
  }

  const result = await db.auth.signUp({
    email,
    password
  });

  if (result.error) {
    toast(result.error.message, "error");
    return;
  }

  closeModal();

  if (result.data?.session) {
    toast("Owner account created.", "success");
  } else {
    toast(
      "Account created. Check your email if confirmation is enabled.",
      "success"
    );
  }

  await load();
}


async function signOut() {
  if (!db) return;

  const result = await db.auth.signOut();

  if (result.error) {
    toast(result.error.message, "error");
    return;
  }

  closeModal();

  user = null;

  toast("Signed out. App is now view-only.", "success");

  await load();
}


/* =========================================================
   NAVIGATION
   ========================================================= */

function nav(screen) {
  document.querySelectorAll(".screen").forEach(el => {
    el.classList.remove("active");
  });

  const target = $(screen);

  if (target) {
    target.classList.add("active");
  }

  document.querySelectorAll("nav button").forEach(btn => {
    btn.classList.toggle(
      "active",
      btn.dataset.s === screen
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
      titles[screen] || "Dream Home";
  }

  if (screen === "dashboard") dashboard();
  if (screen === "payments") payments();
  if (screen === "people") people();
  if (screen === "reports") reports();
  if (screen === "more") more();
}


document.querySelectorAll("nav button").forEach(btn => {
  btn.onclick = () => nav(btn.dataset.s);
});


/* =========================================================
   ACCOUNT ICON
   ========================================================= */

if ($("account")) {
  $("account").onclick = accountPopup;
}


/* =========================================================
   DATE / MONTH HELPERS
   ========================================================= */

function parseStartDate() {
  if (!loan?.start_date) {
    return new Date();
  }

  const d = new Date(`${loan.start_date}T00:00:00`);

  return isNaN(d.getTime())
    ? new Date()
    : d;
}


function monthDate(monthNumber) {
  const start = parseStartDate();

  const d = new Date(
    start.getFullYear(),
    start.getMonth() + monthNumber - 1,
    1
  );

  return d;
}


function monthName(monthNumber) {
  return monthDate(monthNumber).toLocaleDateString(
    "en-IN",
    {
      month: "short",
      year: "numeric"
    }
  );
}


/* =========================================================
   LOAN CALCULATIONS
   ========================================================= */

function monthlyRate() {
  return number(loan?.annual_rate) / 1200;
}


function standardEMI(principal, monthsRemaining) {
  const p = number(principal);
  const n = number(monthsRemaining);
  const r = monthlyRate();

  if (p <= 0 || n <= 0) return 0;

  if (r === 0) {
    return p / n;
  }

  return (
    p *
    r *
    Math.pow(1 + r, n) /
    (Math.pow(1 + r, n) - 1)
  );
}


function fixedEMITotal() {
  return borrowers.reduce(
    (sum, person) =>
      sum + number(person.scheduled_emi),
    0
  );
}


function minimumEMI(principal, monthNumber) {
  const interestOnly =
    number(loan?.interest_only_months) || 0;

  if (monthNumber <= interestOnly) {
    return principal * monthlyRate();
  }

  const remainingMonths =
    Math.max(
      1,
      number(loan?.tenure_months) - monthNumber + 1
    );

  return standardEMI(
    principal,
    remainingMonths
  );
}


/*
  Calculate the entire loan month-by-month.

  Important:
  - NO individual principal-share calculation.
  - Interest is always calculated on the full loan balance.
  - Fixed EMI contributions are added together.
  - Any amount above the minimum required payment reduces
    the overall principal.
  - Personal extra payments reduce the overall principal too.
*/
function calculateLoan() {
  if (!loan) {
    return {
      months: [],
      remaining: 0,
      principalPaid: 0,
      interestPaid: 0,
      totalPaid: 0,
      extraPaid: 0,
      surplusPaid: 0,
      interestSaved: 0
    };
  }

  let balance = number(loan.total_amount);

  let principalPaid = 0;
  let interestPaid = 0;
  let totalPaid = 0;
  let extraPaid = 0;
  let surplusPaid = 0;

  const months = [];

  const interestOnlyMonths =
    number(loan.interest_only_months) || 0;

  const totalFixedEMI = fixedEMITotal();

  for (
    let m = 1;
    m <= number(loan.tenure_months);
    m++
  ) {
    const opening = balance;

    if (balance <= 0) {
      months.push({
        month: m,
        name: monthName(m),
        opening: 0,
        interest: 0,
        fixedEMI: 0,
        extra: 0,
        surplus: 0,
        principal: 0,
        total: 0,
        closing: 0
      });

      continue;
    }

    const interest =
      opening * monthlyRate();

    const monthRows =
      paymentsData.filter(
        x => number(x.month_no) === m
      );

    /*
      We normally assume each person's fixed EMI is paid.

      If an owner edits EMI paid for a month in the database,
      that actual amount is respected.
    */
    let actualEMI = 0;

    borrowers.forEach(person => {
      const row = monthRows.find(
        x => x.borrower_id === person.id
      );

      if (
        row &&
        row.emi_paid !== null &&
        row.emi_paid !== undefined
      ) {
        actualEMI += number(row.emi_paid);
      } else {
        actualEMI += number(person.scheduled_emi);
      }
    });

    /*
      Personal extra contributions.
    */
    const personalExtra = monthRows.reduce(
      (sum, row) =>
        sum + number(row.extra_principal),
      0
    );

    /*
      During interest-only period, fixed EMI is treated as
      interest payment only.

      After interest-only period:
      - interest is paid first
      - remaining fixed EMI reduces principal
      - if fixed EMI is greater than minimum EMI,
        the excess is treated as additional principal
    */

    let regularPrincipal = 0;

    if (m <= interestOnlyMonths) {
      regularPrincipal = 0;
    } else {
      regularPrincipal = Math.max(
        0,
        Math.min(
          balance,
          actualEMI - interest
        )
      );
    }

    /*
      Minimum EMI check.

      If the combined fixed EMIs are higher than the minimum
      EMI required, the difference is separately classified
      as surplus principal.

      We do not double-count it.
    */
    let surplus = 0;

    if (m > interestOnlyMonths) {
      const minEMI =
        minimumEMI(
          opening,
          m
        );

      surplus = Math.max(
        0,
        actualEMI - minEMI
      );

      /*
        The regular principal already contains the whole
        amount above interest. Therefore surplus is a
        classification of part of regular principal, not
        an additional amount.
      */
      surplus = Math.min(
        surplus,
        regularPrincipal
      );
    }

    const extra = Math.min(
      personalExtra,
      Math.max(
        0,
        balance - regularPrincipal
      )
    );

    const totalPrincipal =
      Math.min(
        balance,
        regularPrincipal + extra
      );

    const actualTotalPaid =
      Math.min(
        opening + interest,
        actualEMI + personalExtra
      );

    const unpaidInterest =
      Math.max(
        0,
        interest - actualEMI
      );

    balance =
      Math.max(
        0,
        balance - totalPrincipal
      );

    principalPaid += totalPrincipal;
    interestPaid += Math.min(
      interest,
      actualEMI
    );

    totalPaid += actualTotalPaid;

    extraPaid += extra;
    surplusPaid += surplus;

    months.push({
      month: m,
      name: monthName(m),
      opening,
      interest,
      fixedEMI: actualEMI,
      extra,
      surplus,
      principal: totalPrincipal,
      total: actualTotalPaid,
      closing: balance,
      unpaidInterest
    });
  }

  /*
    Estimate interest saved by extra payments.

    This compares the current schedule against the schedule
    without personal extra payments, using the same fixed EMI.
  */
  const interestSaved =
    calculateInterestWithoutExtras() -
    interestPaid;

  return {
    months,
    remaining: balance,
    principalPaid,
    interestPaid,
    totalPaid,
    extraPaid,
    surplusPaid,
    interestSaved: Math.max(0, interestSaved)
  };
}


/* =========================================================
   INTEREST SAVING CALCULATION
   ========================================================= */

function calculateInterestWithoutExtras() {
  if (!loan) return 0;

  let balance =
    number(loan.total_amount);

  let totalInterest = 0;

  const interestOnlyMonths =
    number(loan.interest_only_months) || 0;

  const fixedEMI =
    fixedEMITotal();

  for (
    let m = 1;
    m <= number(loan.tenure_months);
    m++
  ) {
    if (balance <= 0) break;

    const interest =
      balance * monthlyRate();

    totalInterest += interest;

    let principal = 0;

    if (m > interestOnlyMonths) {
      principal = Math.max(
        0,
        Math.min(
          balance,
          fixedEMI - interest
        )
      );
    }

    balance =
      Math.max(
        0,
        balance - principal
      );
  }

  return totalInterest;
}


/* =========================================================
   PAYMENT LOOKUP
   ========================================================= */

function getPayment(monthNo, borrowerId) {
  return (
    paymentsData.find(
      p =>
        number(p.month_no) === number(monthNo) &&
        p.borrower_id === borrowerId
    ) || null
  );
}


/* =========================================================
   LOAD FROM SUPABASE
   ========================================================= */

async function load() {
  cloudStatus("");

  if (!db) {
    user = null;
    loan = null;
    borrowers = [];
    paymentsData = [];

    cloudStatus("bad");
    dashboard();

    return;
  }

  try {
    const authResult =
      await db.auth.getUser();

    user =
      authResult?.data?.user || null;

    /*
      Load the first loan.

      Existing Dream Home uses one loan.
    */
    const loanResult =
      await db
        .from("loans")
        .select("*")
        .order("created_at", {
          ascending: true
        })
        .limit(1)
        .maybeSingle();

    if (loanResult.error) {
      console.error(
        "Loan load error:",
        loanResult.error
      );

      cloudStatus("bad");

      dashboard();

      toast(
        loanResult.error.message,
        "error"
      );

      return;
    }

    loan = loanResult.data || null;

    borrowers = [];
    paymentsData = [];

    if (loan) {
      const borrowerResult =
        await db
          .from("borrowers")
          .select("*")
          .eq("loan_id", loan.id)
          .order("sort_order", {
            ascending: true
          });

      if (borrowerResult.error) {
        console.error(
          borrowerResult.error
        );

        toast(
          borrowerResult.error.message,
          "error"
        );
      } else {
        borrowers =
          borrowerResult.data || [];
      }

      const paymentResult =
        await db
          .from("monthly_payments")
          .select("*")
          .eq("loan_id", loan.id)
          .order("month_no", {
            ascending: true
          });

      if (paymentResult.error) {
        console.error(
          paymentResult.error
        );

        toast(
          paymentResult.error.message,
          "error"
        );
      } else {
        paymentsData =
          paymentResult.data || [];
      }
    }

    cloudStatus("ok");

    dashboard();

  } catch (error) {
    console.error(error);

    cloudStatus("bad");

    dashboard();

    toast(
      "Unable to connect to cloud.",
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

  if (!loan) {
    el.innerHTML = `
      <div class="hero">
        <small>DREAM HOME</small>
        <strong>Loan Tracker</strong>
        <div>
          Your cloud-connected home loan dashboard.
        </div>
      </div>

      <div class="card">
        <div class="pt">
          <div>
            <h2>Welcome</h2>
            <p class="muted">
              ${READY
                ? "No loan has been created yet."
                : "Supabase connection needs to be configured."}
            </p>
          </div>
          <span class="pill">
            ${user ? "OWNER" : "VIEW ONLY"}
          </span>
        </div>

        ${
          user
            ? `
              <button
                class="btn primary"
                onclick="loanCreate()">
                ＋ Create Loan
              </button>
            `
            : `
              <p class="muted">
                Tap the 👤 icon at the top to sign in
                as the owner.
              </p>
            `
        }
      </div>
    `;

    return;
  }

  const data = calculateLoan();

  const original =
    number(loan.total_amount);

  const paidPercent =
    original > 0
      ? (data.principalPaid / original) * 100
      : 0;

  const fixedEMI =
    fixedEMITotal();

  const currentMonth =
    data.months.find(
      x => x.closing > 0
    ) || data.months[data.months.length - 1];

  el.innerHTML = `
    <div class="hero">
      <small>REMAINING PRINCIPAL</small>

      <strong>
        ${money(data.remaining)}
      </strong>

      <div>
        ${money(original)}
        original loan
        · ${number(loan.annual_rate)}% p.a.
        · ${number(loan.tenure_months)} months
      </div>
    </div>

    <div class="metrics">

      <div class="metric">
        <small>Principal paid</small>
        <strong>
          ${money(data.principalPaid)}
        </strong>
      </div>

      <div class="metric">
        <small>Interest paid</small>
        <strong>
          ${money(data.interestPaid)}
        </strong>
      </div>

      <div class="metric">
        <small>Total paid</small>
        <strong>
          ${money(data.totalPaid)}
        </strong>
      </div>

      <div class="metric">
        <small>Loan paid</small>
        <strong>
          ${paidPercent.toFixed(1)}%
        </strong>
      </div>

      <div class="metric">
        <small>Extra principal</small>
        <strong>
          ${money(data.extraPaid)}
        </strong>
      </div>

      <div class="metric">
        <small>Interest saved</small>
        <strong>
          ${money(data.interestSaved)}
        </strong>
      </div>

    </div>

    <div class="card">
      <div class="pt">
        <div>
          <h2>Loan summary</h2>
          <div class="muted">
            ${
              currentMonth
                ? `Current schedule: ${esc(currentMonth.name)}`
                : ""
            }
          </div>
        </div>

        <span class="pill">
          ${isOwner() ? "OWNER" : "VIEW ONLY"}
        </span>
      </div>

      <div class="row">
        <span>Original loan</span>
        <b>${money(original)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${money(data.remaining)}</b>
      </div>

      <div class="row">
        <span>Fixed monthly EMI</span>
        <b>${money(fixedEMI)}</b>
      </div>

      <div class="row">
        <span>Annual interest</span>
        <b>${number(loan.annual_rate)}%</b>
      </div>

      <div class="row">
        <span>Interest-only period</span>
        <b>
          ${
            number(loan.interest_only_months)
          } months
        </b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>${paidPercent.toFixed(1)}%</b>
      </div>

      <div class="bar">
        <i style="width:${Math.min(
          100,
          Math.max(0, paidPercent)
        )}%"></i>
      </div>
    </div>

    <div class="card">
      <div class="pt">
        <h2>People</h2>
        <span class="pill">
          ${borrowers.length}
        </span>
      </div>

      ${
        borrowers.length
          ? borrowers
              .map(renderPersonSummary)
              .join("")
          : `
            <div class="empty">
              No borrowers added.
            </div>
          `
      }
    </div>

    ${
      isOwner()
        ? `
          <div class="actions">

            <button
              class="btn primary"
              onclick="payment()">
              ＋ Record Payment
            </button>

            <button
              class="btn soft"
              onclick="loanEdit()">
              ⚙️ Loan Settings
            </button>

          </div>
        `
        : ""
    }
  `;
}


function renderPersonSummary(person) {
  const rows =
    paymentsData.filter(
      p => p.borrower_id === person.id
    );

  const emiPaid =
    rows.reduce(
      (sum, row) =>
        sum + number(row.emi_paid),
      0
    );

  const extra =
    rows.reduce(
      (sum, row) =>
        sum + number(row.extra_principal),
      0
    );

  const total =
    emiPaid + extra;

  const loanTotal =
    number(loan.total_amount);

  const percent =
    loanTotal > 0
      ? (total / loanTotal) * 100
      : 0;

  return `
    <div class="person">

      <div class="pt">
        <b>${esc(person.name)}</b>

        <span class="pill">
          ${money(person.scheduled_emi)}/mo
        </span>
      </div>

      <div class="row">
        <span>EMI paid</span>
        <b>${money(emiPaid)}</b>
      </div>

      <div class="row">
        <span>Extra paid</span>
        <b>${money(extra)}</b>
      </div>

      <div class="row">
        <span>Total contribution</span>
        <b>${money(total)}</b>
      </div>

      <div class="row">
        <span>% of total loan</span>
        <b>${percent.toFixed(2)}%</b>
      </div>

    </div>
  `;
}


/* =========================================================
   CREATE LOAN
   ========================================================= */

function loanCreate() {
  if (!isOwner() && user) {
    /*
      A newly signed-up owner may not have a loan yet,
      therefore allow creation when user exists.
    */
  }

  if (!user) {
    accountPopup();
    return;
  }

  openModal(`
    <h2>Create Dream Home Loan</h2>

    <p class="muted">
      Enter the overall loan details first.
      Borrowers can be added afterwards.
    </p>

    <label>
      Loan name
      <input id="newLoanName"
             value="Dream Home Loan">
    </label>

    <div class="grid">

      <label>
        Overall loan amount
        <input id="newLoanAmount"
               type="number"
               value="4500000">
      </label>

      <label>
        Annual interest %
        <input id="newLoanRate"
               type="number"
               step="0.01"
               value="8.9">
      </label>

      <label>
        Tenure (months)
        <input id="newLoanTenure"
               type="number"
               value="240">
      </label>

      <label>
        Start date
        <input id="newLoanStart"
               type="date">
      </label>

      <label>
        Interest-only months
        <input id="newLoanInterestOnly"
               type="number"
               min="0"
               value="0">
      </label>

    </div>

    <button
      class="btn primary"
      onclick="saveNewLoan()">
      Create Loan
    </button>
  `);

  if ($("newLoanStart")) {
    const today =
      new Date().toISOString().slice(0, 10);

    $("newLoanStart").value = today;
  }
}


async function saveNewLoan() {
  if (!db || !user) return;

  const data = {
    name:
      $("newLoanName").value.trim() ||
      "Dream Home Loan",

    total_amount:
      number($("newLoanAmount").value),

    annual_rate:
      number($("newLoanRate").value),

    tenure_months:
      number($("newLoanTenure").value),

    start_date:
      $("newLoanStart").value,

    interest_only_months:
      number($("newLoanInterestOnly").value),

    emi_mode: "auto",

    manual_emi: 0,

    created_by: user.id
  };

  if (
    data.total_amount <= 0 ||
    data.tenure_months <= 0
  ) {
    toast(
      "Enter a valid loan amount and tenure.",
      "error"
    );
    return;
  }

  const result =
    await db
      .from("loans")
      .insert(data)
      .select()
      .single();

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    "Dream Home loan created.",
    "success"
  );

  await load();
}


/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function loanEdit() {
  if (!isOwner()) {
    accountPopup();
    return;
  }

  openModal(`
    <h2>Loan Settings</h2>

    <div class="grid">

      <label class="full">
        Loan name
        <input id="loanName"
               value="${esc(loan.name)}">
      </label>

      <label>
        Overall loan amount
        <input id="loanAmount"
               type="number"
               value="${number(loan.total_amount)}">
      </label>

      <label>
        Annual interest %
        <input id="loanRate"
               type="number"
               step="0.01"
               value="${number(loan.annual_rate)}">
      </label>

      <label>
        Tenure (months)
        <input id="loanTenure"
               type="number"
               value="${number(loan.tenure_months)}">
      </label>

      <label>
        Start date
        <input id="loanStart"
               type="date"
               value="${loan.start_date || ""}">
      </label>

      <label>
        Interest-only months
        <input id="loanInterestOnly"
               type="number"
               min="0"
               value="${number(loan.interest_only_months)}">
      </label>

    </div>

    <button
      class="btn primary"
      onclick="saveLoanSettings()">
      Save Settings
    </button>

    <button
      class="btn danger"
      onclick="confirmLoanReset()">
      🔄 Loan Reset
    </button>
  `);
}


async function saveLoanSettings() {
  if (!isOwner()) return;

  const values = {
    name:
      $("loanName").value.trim() ||
      "Dream Home Loan",

    total_amount:
      number($("loanAmount").value),

    annual_rate:
      number($("loanRate").value),

    tenure_months:
      number($("loanTenure").value),

    start_date:
      $("loanStart").value,

    interest_only_months:
      number($("loanInterestOnly").value),

    updated_at:
      new Date().toISOString()
  };

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

  closeModal();

  toast(
    "Loan settings updated.",
    "success"
  );

  await load();
}


/* =========================================================
   BORROWERS
   ========================================================= */

function people() {
  const el = $("people");

  if (!el) return;

  el.innerHTML = `
    <div class="card">

      <div class="pt">

        <div>
          <h2>People</h2>
          <div class="muted">
            Fixed EMI contributions
          </div>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="btn soft"
                onclick="person()">
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

      ${
        borrowers.length
          ? borrowers.map(personRow).join("")
          : `
            <div class="empty">
              No people added yet.
            </div>
          `
      }

    </div>
  `;
}


function personRow(person) {
  const rows =
    paymentsData.filter(
      p => p.borrower_id === person.id
    );

  const emi =
    rows.reduce(
      (sum, row) =>
        sum + number(row.emi_paid),
      0
    );

  const extra =
    rows.reduce(
      (sum, row) =>
        sum + number(row.extra_principal),
      0
    );

  const total =
    emi + extra;

  const percent =
    number(loan.total_amount) > 0
      ? total /
        number(loan.total_amount) *
        100
      : 0;

  return `
    <div class="row">

      <div>
        <b>${esc(person.name)}</b>

        <div class="muted">
          Fixed EMI:
          ${money(person.scheduled_emi)}
        </div>

        <div class="muted">
          Contribution:
          ${money(total)}
          · ${percent.toFixed(2)}%
        </div>
      </div>

      ${
        isOwner()
          ? `
            <button
              class="btn soft"
              onclick="person('${person.id}')">
              Edit
            </button>
          `
          : ""
      }

    </div>
  `;
}


function person(id) {
  if (!isOwner()) {
    accountPopup();
    return;
  }

  const personData =
    borrowers.find(
      x => x.id === id
    ) || {
      name: "",
      scheduled_emi: 0
    };

  openModal(`
    <h2>
      ${id ? "Edit" : "Add"} Person
    </h2>

    <label>
      Name
      <input id="personName"
             value="${esc(personData.name)}"
             placeholder="Person name">
    </label>

    <label>
      Fixed monthly EMI
      <input id="personEMI"
             type="number"
             value="${number(personData.scheduled_emi)}">
    </label>

    <p class="muted">
      This EMI is automatically used for every month.
      You do not need to enter the fixed EMI again.
    </p>

    <button
      class="btn primary"
      onclick="savePerson('${id || ""}')">
      Save Person
    </button>

    ${
      id
        ? `
          <button
            class="btn danger"
            onclick="deletePerson('${id}')">
            Delete Person
          </button>
        `
        : ""
    }
  `);
}


async function savePerson(id) {
  if (!isOwner()) return;

  const values = {
    loan_id: loan.id,

    name:
      $("personName").value.trim() ||
      "Person",

    scheduled_emi:
      number($("personEMI").value),

    /*
      Keep the old column harmlessly at zero.
      New app does not use it.
    */
    share_amount: 0,

    sort_order: id
      ? (
          borrowers.find(
            x => x.id === id
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
      ? "Person updated."
      : "Person added.",
    "success"
  );

  await load();
}


async function deletePerson(id) {
  if (!isOwner()) return;

  openModal(`
    <h2>Delete person?</h2>

    <p class="muted">
      This will delete this person's payment records too.
    </p>

    <button
      class="btn danger"
      onclick="confirmDeletePerson('${id}')">
      Delete
    </button>

    <button
      class="btn soft"
      onclick="closeModal()">
      Cancel
    </button>
  `);
}


async function confirmDeletePerson(id) {
  if (!isOwner()) return;

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
    "Person deleted.",
    "success"
  );

  await load();
}


/* =========================================================
   PAYMENT ENTRY
   ========================================================= */

function payment(monthNumber = null) {
  if (!isOwner()) {
    accountPopup();
    return;
  }

  const m =
    monthNumber ||
    findNextPaymentMonth();

  if (
    !m ||
    m < 1 ||
    m > number(loan.tenure_months)
  ) {
    toast(
      "No available loan month.",
      "error"
    );
    return;
  }

  paymentPopup(m);
}


function findNextPaymentMonth() {
  for (
    let m = 1;
    m <= number(loan.tenure_months);
    m++
  ) {
    const exists =
      borrowers.some(
        b =>
          getPayment(m, b.id)
      );

    if (!exists) return m;
  }

  return number(loan.tenure_months);
}


function paymentPopup(monthNo) {
  const existing =
    paymentsData.filter(
      x =>
        number(x.month_no) ===
        number(monthNo)
    );

  const previous =
    calculateLoan()
      .months
      .find(
        x => x.month === monthNo
      );

  openModal(`
    <h2>
      ${esc(monthName(monthNo))}
    </h2>

    <p class="muted">
      Fixed EMI is automatically included.
      Enter only the <b>extra principal</b>
      paid by each person.
    </p>

    <div class="payment-info">

      <div>
        <small>Opening principal</small>
        <b>
          ${money(previous?.opening || 0)}
        </b>
      </div>

      <div>
        <small>Interest for month</small>
        <b>
          ${money(previous?.interest || 0)}
        </b>
      </div>

      <div>
        <small>Fixed EMI total</small>
        <b>
          ${money(fixedEMITotal())}
        </b>
      </div>

    </div>

    <div id="paymentPeople"></div>

    <button
      class="btn primary"
      onclick="saveMonthPayment(${monthNo})">
      ✓ Pay & Save
    </button>

    ${
      existing.length
        ? `
          <button
            class="btn soft"
            onclick="deleteMonthPayments(${monthNo})">
            Delete this month's payment
          </button>
        `
        : ""
    }
  `);

  const container =
    $("paymentPeople");

  if (!container) return;

  container.innerHTML =
    borrowers
      .map(person => {
        const old =
          getPayment(
            monthNo,
            person.id
          );

        return `
          <div class="pay">

            <div class="pt">

              <b>
                ${esc(person.name)}
              </b>

              <span class="pill">
                EMI ${money(
                  person.scheduled_emi
                )}
              </span>

            </div>

            <label>
              Extra principal paid
              <input
                id="extra_${person.id}"
                type="number"
                min="0"
                step="1"
                value="${
                  old
                    ? number(
                        old.extra_principal
                      )
                    : ""
                }"
                placeholder="₹ 0">
            </label>

            <div class="calc">
              Fixed EMI:
              <b>
                ${money(person.scheduled_emi)}
              </b>

              <br>

              ${
                old
                  ? "Existing payment — edit the extra amount and save."
                  : "Only enter extra payment if this person paid extra."
              }
            </div>

          </div>
        `;
      })
      .join("");
}


async function saveMonthPayment(monthNo) {
  if (!isOwner()) return;

  if (!borrowers.length) {
    toast(
      "Add at least one person first.",
      "error"
    );
    return;
  }

  for (const person of borrowers) {
    const field =
      $(`extra_${person.id}`);

    const extra =
      number(field?.value);

    const old =
      getPayment(
        monthNo,
        person.id
      );

    /*
      Fixed EMI is automatically stored.
      User never needs to re-enter it.
    */
    const values = {
      loan_id: loan.id,

      borrower_id:
        person.id,

      month_no:
        monthNo,

      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      emi_paid:
        number(person.scheduled_emi),

      extra_principal:
        Math.max(0, extra)
    };

    let result;

    if (old) {
      result =
        await db
          .from("monthly_payments")
          .update(values)
          .eq("id", old.id);
    } else {
      result =
        await db
          .from("monthly_payments")
          .insert(values);
    }

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
    `${monthName(monthNo)} payment saved.`,
    "success"
  );

  await load();
}


/* =========================================================
   DELETE MONTH
   ========================================================= */

async function deleteMonthPayments(monthNo) {
  if (!isOwner()) return;

  openModal(`
    <h2>Delete ${esc(monthName(monthNo))}?</h2>

    <p class="muted">
      All payment entries for this month will be deleted.
    </p>

    <button
      class="btn danger"
      onclick="confirmDeleteMonth(${monthNo})">
      Delete
    </button>

    <button
      class="btn soft"
      onclick="closeModal()">
      Cancel
    </button>
  `);
}


async function confirmDeleteMonth(monthNo) {
  if (!isOwner()) return;

  const result =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loan.id)
      .eq("month_no", monthNo);

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    `${monthName(monthNo)} deleted.`,
    "success"
  );

  await load();
}


/* =========================================================
   PAYMENTS PAGE
   ========================================================= */

function payments() {
  const el = $("payments");

  if (!el) return;

  if (!loan) {
    el.innerHTML = `
      <div class="card">
        <div class="empty">
          No loan available.
        </div>
      </div>
    `;

    return;
  }

  const months =
    [...new Set(
      paymentsData.map(
        x => number(x.month_no)
      )
    )].sort(
      (a, b) => b - a
    );

  el.innerHTML = `
    <div class="card">

      <div class="pt">

        <div>
          <h2>Payments</h2>

          <div class="muted">
            Enter extra payment only.
            Fixed EMI is automatic.
          </div>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="btn primary"
                onclick="payment()">
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

      ${
        months.length
          ? months
              .map(
                m =>
                  renderPaymentMonth(m)
              )
              .join("")
          : `
            <div class="empty">
              No monthly payments recorded yet.
            </div>
          `
      }

    </div>
  `;
}


function renderPaymentMonth(monthNo) {
  const rows =
    paymentsData.filter(
      x =>
        number(x.month_no) ===
        monthNo
    );

  const extra =
    rows.reduce(
      (sum, x) =>
        sum + number(x.extra_principal),
      0
    );

  const emi =
    rows.reduce(
      (sum, x) =>
        sum + number(x.emi_paid),
      0
    );

  const calc =
    calculateLoan()
      .months
      .find(
        x => x.month === monthNo
      );

  return `
    <div class="row">

      <div>
        <b>
          ${esc(monthName(monthNo))}
        </b>

        <div class="muted">
          EMI ${money(emi)}
          · Extra ${money(extra)}
        </div>

        ${
          calc
            ? `
              <div class="muted">
                Principal:
                ${money(calc.principal)}
                · Interest:
                ${money(calc.interest)}
                · Balance:
                ${money(calc.closing)}
              </div>
            `
            : ""
        }
      </div>

      ${
        isOwner()
          ? `
            <button
              class="btn soft"
              onclick="payment(${monthNo})">
              ✏️ Edit
            </button>
          `
          : ""
      }

    </div>
  `;
}


/* =========================================================
   REPORTS
   ========================================================= */

function reports() {
  const el = $("reports");

  if (!el) return;

  if (!loan) {
    el.innerHTML = `
      <div class="card">
        <div class="empty">
          No loan available.
        </div>
      </div>
    `;

    return;
  }

  const data =
    calculateLoan();

  const original =
    number(loan.total_amount);

  const percent =
    original > 0
      ? data.principalPaid /
        original *
        100
      : 0;

  el.innerHTML = `
    <div class="card">

      <h2>Loan Report</h2>

      <div class="row">
        <span>Original loan</span>
        <b>${money(original)}</b>
      </div>

      <div class="row">
        <span>Principal paid</span>
        <b>${money(data.principalPaid)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${money(data.remaining)}</b>
      </div>

      <div class="row">
        <span>Interest paid</span>
        <b>${money(data.interestPaid)}</b>
      </div>

      <div class="row">
        <span>Total paid</span>
        <b>${money(data.totalPaid)}</b>
      </div>

      <div class="row">
        <span>Extra principal</span>
        <b>${money(data.extraPaid)}</b>
      </div>

      <div class="row">
        <span>Interest saved</span>
        <b>${money(data.interestSaved)}</b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>${percent.toFixed(2)}%</b>
      </div>

    </div>

    <div class="card">

      <h2>Person-wise contribution</h2>

      ${
        borrowers.length
          ? borrowers
              .map(reportPerson)
              .join("")
          : `
            <div class="empty">
              No people added.
            </div>
          `
      }

    </div>

    <div class="card">

      <h2>Monthly schedule</h2>

      <div class="table">
        <table>

          <tr>
            <th>Month</th>
            <th>Interest</th>
            <th>Principal</th>
            <th>Extra</th>
            <th>Balance</th>
          </tr>

          ${
            data.months
              .filter(
                x =>
                  x.opening > 0 ||
                  x.total > 0
              )
              .map(
                x => `
                  <tr>
                    <td>
                      ${esc(x.name)}
                    </td>
                    <td>
                      ${money(x.interest)}
                    </td>
                    <td>
                      ${money(x.principal)}
                    </td>
                    <td>
                      ${money(x.extra)}
                    </td>
                    <td>
                      ${money(x.closing)}
                    </td>
                  </tr>
                `
              )
              .join("")
          }

        </table>
      </div>

    </div>
  `;
}


function reportPerson(person) {
  const rows =
    paymentsData.filter(
      x => x.borrower_id === person.id
    );

  const emi =
    rows.reduce(
      (s, x) =>
        s + number(x.emi_paid),
      0
    );

  const extra =
    rows.reduce(
      (s, x) =>
        s + number(x.extra_principal),
      0
    );

  const total =
    emi + extra;

  const percentage =
    number(loan.total_amount) > 0
      ? total /
        number(loan.total_amount) *
        100
      : 0;

  return `
    <div class="row">

      <div>
        <b>${esc(person.name)}</b>

        <div class="muted">
          EMI paid:
          ${money(emi)}
        </div>

        <div class="muted">
          Extra:
          ${money(extra)}
        </div>
      </div>

      <div style="text-align:right">
        <b>${money(total)}</b>
        <div class="muted">
          ${percentage.toFixed(2)}%
        </div>
      </div>

    </div>
  `;
}


/* =========================================================
   MORE PAGE
   ========================================================= */

function more() {
  const el = $("more");

  if (!el) return;

  el.innerHTML = `
    <div class="card">

      <h2>Account</h2>

      ${
        user
          ? `
            <div class="account-status">
              <span class="status-dot"></span>
              Owner signed in
            </div>

            <div class="muted">
              ${esc(user.email)}
            </div>

            <button
              class="btn danger"
              onclick="signOut()">
              Sign out
            </button>
          `
          : `
            <div class="muted">
              Public view mode.
              Editing is available only to the owner.
            </div>

            <p class="muted">
              Use the 👤 icon at the top for owner sign-in.
            </p>
          `
      }

    </div>

    ${
      isOwner()
        ? `
          <div class="card">

            <h2>Manage Loan</h2>

            <div class="row">
              <b>Loan settings</b>

              <button
                class="btn soft"
                onclick="loanEdit()">
                Open
              </button>
            </div>

            <div class="row">
              <b>Reset loan</b>

              <button
                class="btn danger"
                onclick="confirmLoanReset()">
                Reset
              </button>
            </div>

          </div>
        `
        : ""
    }

    <div class="card">

      <h2>Cloud</h2>

      <div class="row">

        <span>Status</span>

        <b>
          ${
            READY
              ? "Connected"
              : "Not configured"
          }
        </b>

      </div>

      <p class="muted">
        Dream Home stores loan data in Supabase
        so the same information can be viewed
        from other devices.
      </p>

    </div>
  `;
}


/* =========================================================
   LOAN RESET
   ========================================================= */

function confirmLoanReset() {
  if (!isOwner()) {
    accountPopup();
    return;
  }

  openModal(`
    <h2>Reset entire loan?</h2>

    <p class="muted">
      This is a complete reset.
      All people and monthly payment records
      will be removed.
    </p>

    <p>
      <b>This action cannot be undone.</b>
    </p>

    <button
      class="btn danger"
      onclick="resetLoan()">
      Yes, Reset Loan
    </button>

    <button
      class="btn soft"
      onclick="closeModal()">
      Cancel
    </button>
  `);
}


async function resetLoan() {
  if (!isOwner()) return;

  /*
    Delete payments first.
  */
  let result =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loan.id);

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  /*
    Delete borrowers.
  */
  result =
    await db
      .from("borrowers")
      .delete()
      .eq("loan_id", loan.id);

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  /*
    Delete loan.
  */
  result =
    await db
      .from("loans")
      .delete()
      .eq("id", loan.id);

  if (result.error) {
    toast(
      result.error.message,
      "error"
    );
    return;
  }

  closeModal();

  toast(
    "Loan has been reset.",
    "success"
  );

  await load();
}


/* =========================================================
   AUTH STATE
   ========================================================= */

if (db) {

  db.auth.onAuthStateChange(
    () => {
      /*
        Delay prevents Supabase auth events from
        triggering nested auth calls.
      */
      setTimeout(
        () => load(),
        0
      );
    }
  );

}


/* =========================================================
   SERVICE WORKER
   ========================================================= */

if (
  "serviceWorker" in navigator
) {
  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(error => {
          console.warn(
            "Service worker registration failed:",
            error
          );
        });
    }
  );
}


/* =========================================================
   INITIAL START
   ========================================================= */

(async function startDreamHome() {

  /*
    Always render the UI first.
    This prevents a blank Home page if cloud loading
    encounters a problem.
  */
  dashboard();

  /*
    Make sure the account icon is available.
  */
  if ($("account")) {
    $("account").onclick =
      accountPopup;
  }

  /*
    Open Dashboard.
  */
  nav("dashboard");

  /*
    Then load cloud data.
  */
  await load();

})();
