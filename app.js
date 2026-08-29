/* =========================================================
   DREAM HOME v3
   Common Loan Principal System
   Public View + Owner-only Editing
   Supabase Cloud Sync
   ========================================================= */

const CFG = window.DREAM_HOME || {};

const ready =
  CFG.url &&
  !CFG.url.includes("PASTE_") &&
  CFG.key &&
  !CFG.key.includes("PASTE_");

const db = ready
  ? supabase.createClient(CFG.url, CFG.key)
  : null;

let user = null;
let loan = null;
let bs = [];
let ps = [];

/* =========================================================
   HELPERS
   ========================================================= */

const $ = id => document.getElementById(id);

const M = n =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(Number(n) || 0));

const esc = x =>
  String(x ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function toast(message, type = "normal") {
  const t = $("toast");

  if (!t) return;

  t.className = "toast " + type;
  t.textContent = message;
  t.style.display = "block";

  clearTimeout(window.toastTimer);

  window.toastTimer = setTimeout(() => {
    t.style.display = "none";
  }, 2500);
}

function sync(state) {
  const s = $("sync");

  if (!s) return;

  s.className =
    state === "ok"
      ? "ok"
      : state === "bad"
      ? "bad"
      : "";
}

function edit() {
  return !!user && !!loan && loan.created_by === user.id;
}

function monthlyRate() {
  if (!loan) return 0;

  return (Number(loan.annual_rate) || 0) / 1200;
}

/* =========================================================
   EMI
   ========================================================= */

function emi(principal, months) {
  principal = Number(principal) || 0;
  months = Number(months) || 0;

  if (!principal || !months) return 0;

  const r = monthlyRate();

  if (!r) return principal / months;

  return (
    principal *
    r *
    Math.pow(1 + r, months) /
    (Math.pow(1 + r, months) - 1)
  );
}

function overallEMI() {
  if (!loan) return 0;

  if (loan.emi_mode === "manual") {
    return Number(loan.manual_emi) || 0;
  }

  return emi(
    Number(loan.total_amount),
    Number(loan.tenure_months)
  );
}

/* =========================================================
   DATE / MONTH
   ========================================================= */

function monthLabel(monthNo) {
  if (!loan || !loan.start_date) {
    return "Month " + monthNo;
  }

  const d = new Date(loan.start_date + "T00:00:00");

  d.setMonth(d.getMonth() + Number(monthNo) - 1);

  return d.toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric"
  });
}

function monthDate(monthNo) {
  if (!loan || !loan.start_date) return null;

  const d = new Date(loan.start_date + "T00:00:00");

  d.setMonth(d.getMonth() + Number(monthNo) - 1);

  return d;
}

/* =========================================================
   PAYMENT FINDER
   ========================================================= */

function getPayment(monthNo, borrowerId) {
  return (
    ps.find(
      p =>
        Number(p.month_no) === Number(monthNo) &&
        p.borrower_id === borrowerId
    ) || {
      emi_paid: 0,
      extra_principal: 0
    }
  );
}

/* =========================================================
   COMMON LOAN CALCULATION
   =========================================================

   IMPORTANT:

   There is NO borrower principal share.

   The entire loan starts from loan.total_amount.

   Interest is calculated on the remaining COMMON
   principal every month.

   Regular EMI:
      EMI - interest = principal

   During interest-only period:
      EMI pays interest only.

   Extra payment:
      100% directly reduces common principal.

   ========================================================= */

function calculateLoan(upToMonth) {
  if (!loan) {
    return {
      balance: 0,
      principalPaid: 0,
      regularPrincipalPaid: 0,
      extraPaid: 0,
      interestDue: 0,
      interestPaid: 0,
      unpaidInterest: 0,
      totalPaid: 0
    };
  }

  let balance = Number(loan.total_amount) || 0;

  let principalPaid = 0;
  let regularPrincipalPaid = 0;
  let extraPaid = 0;

  let interestDueTotal = 0;
  let interestPaidTotal = 0;
  let unpaidInterestTotal = 0;

  let totalPaid = 0;

  const rate = monthlyRate();

  const interestOnlyMonths =
    Number(loan.interest_only_months) || 0;

  const endMonth =
    Number(upToMonth) ||
    Number(loan.tenure_months) ||
    0;

  for (let month = 1; month <= endMonth; month++) {

    if (balance <= 0) break;

    const monthPayments = ps.filter(
      p => Number(p.month_no) === month
    );

    const regularEMI = monthPayments.reduce(
      (sum, p) =>
        sum + (Number(p.emi_paid) || 0),
      0
    );

    const extra = monthPayments.reduce(
      (sum, p) =>
        sum + (Number(p.extra_principal) || 0),
      0
    );

    const interestDue = balance * rate;

    interestDueTotal += interestDue;

    /*
      First regular EMI pays interest.
    */

    const interestPaid =
      Math.min(regularEMI, interestDue);

    interestPaidTotal += interestPaid;

    if (regularEMI < interestDue) {
      unpaidInterestTotal +=
        interestDue - regularEMI;
    }

    let regularPrincipal = 0;

    /*
      Interest-only period.
    */

    if (month > interestOnlyMonths) {
      regularPrincipal = Math.min(
        Math.max(
          0,
          regularEMI - interestDue
        ),
        balance
      );
    }

    /*
      Extra payment ALWAYS goes directly
      toward principal.
    */

    const extraPrincipal = Math.min(
      Math.max(0, extra),
      Math.max(
        0,
        balance - regularPrincipal
      )
    );

    balance -= regularPrincipal;
    balance -= extraPrincipal;

    balance = Math.max(0, balance);

    regularPrincipalPaid += regularPrincipal;
    extraPaid += extraPrincipal;

    principalPaid +=
      regularPrincipal + extraPrincipal;

    totalPaid +=
      regularEMI + extra;
  }

  return {
    balance,
    principalPaid,
    regularPrincipalPaid,
    extraPaid,
    interestDue: interestDueTotal,
    interestPaid: interestPaidTotal,
    unpaidInterest: unpaidInterestTotal,
    totalPaid
  };
}

/* =========================================================
   PERSON CONTRIBUTION
   ========================================================= */

function personStats(borrowerId) {
  const personPayments = ps.filter(
    p => p.borrower_id === borrowerId
  );

  let emiPaid = 0;
  let extraPaid = 0;

  personPayments.forEach(p => {
    emiPaid += Number(p.emi_paid) || 0;
    extraPaid +=
      Number(p.extra_principal) || 0;
  });

  return {
    emiPaid,
    extraPaid,
    totalPaid: emiPaid + extraPaid
  };
}

/* =========================================================
   NAVIGATION
   ========================================================= */

function nav(id) {

  document
    .querySelectorAll(".screen")
    .forEach(x =>
      x.classList.remove("active")
    );

  const screen = $(id);

  if (screen) {
    screen.classList.add("active");
  }

  document
    .querySelectorAll("nav button")
    .forEach(x =>
      x.classList.toggle(
        "active",
        x.dataset.s === id
      )
    );

  const titles = {
    dashboard: "Dashboard",
    payments: "Payments",
    people: "People",
    reports: "Reports",
    more: "More"
  };

  if ($("title")) {
    $("title").textContent =
      titles[id] || "Dream Home";
  }

  if (id === "dashboard") dashboard();
  if (id === "payments") payments();
  if (id === "people") people();
  if (id === "reports") reports();
  if (id === "more") more();
}

/* =========================================================
   ACCOUNT ICON
   ========================================================= */

if ($("account")) {
  $("account").onclick = () => {

    if (user) {
      accountPopup();
    } else {
      auth();
    }

  };
}

/* =========================================================
   LOAD CLOUD DATA
   ========================================================= */

async function load() {

  if (!db) {
    sync("bad");
    dashboard();
    return;
  }

  try {

    sync("");

    const authResult =
      await db.auth.getUser();

    user =
      authResult.data?.user || null;

    /*
      Load the loan.

      Public users can read the loan.
      Owner can also edit.
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
        loanResult.error
      );

      toast(
        loanResult.error.message,
        "error"
      );

      sync("bad");
      return;
    }

    loan = loanResult.data;

    if (loan) {

      const [
        borrowersResult,
        paymentsResult
      ] = await Promise.all([

        db
          .from("borrowers")
          .select("*")
          .eq("loan_id", loan.id)
          .order("sort_order"),

        db
          .from("monthly_payments")
          .select("*")
          .eq("loan_id", loan.id)
          .order("month_no")
      ]);

      if (borrowersResult.error) {
        toast(
          borrowersResult.error.message,
          "error"
        );
      }

      if (paymentsResult.error) {
        toast(
          paymentsResult.error.message,
          "error"
        );
      }

      bs =
        borrowersResult.data || [];

      ps =
        paymentsResult.data || [];

    } else {

      bs = [];
      ps = [];

    }

    sync("ok");

    dashboard();

  } catch (err) {

    console.error(err);

    sync("bad");

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

  if (!$("dashboard")) return;

  if (!loan) {

    $("dashboard").innerHTML = `
      <div class="hero">
        <small>DREAM HOME</small>
        <strong>Home Loan Tracker</strong>
        <div>
          Public view is ready.
        </div>
      </div>

      <div class="card">
        <h2>Welcome</h2>

        <p class="muted">
          Owner sign-in is required to create
          and manage the cloud loan.
        </p>

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
                Tap the person icon above
                to sign in as owner.
              </p>
            `
        }
      </div>
    `;

    return;
  }

  const result =
    calculateLoan(
      Number(loan.tenure_months)
    );

  const original =
    Number(loan.total_amount) || 0;

  const principalPaid =
    result.principalPaid;

  const remaining =
    Math.max(
      0,
      original - principalPaid
    );

  const paidPercent =
    original > 0
      ? Math.min(
          100,
          (principalPaid / original) * 100
        )
      : 0;

  const totalContribution =
    bs.reduce(
      (sum, b) =>
        sum +
        personStats(b.id).totalPaid,
      0
    );

  $("dashboard").innerHTML = `

    <div class="hero">

      <small>REMAINING PRINCIPAL</small>

      <strong>
        ${M(remaining)}
      </strong>

      <div>
        ${paidPercent.toFixed(2)}%
        of loan principal paid
      </div>

      <div class="bar">
        <i
          style="
            width:${Math.max(
              0,
              Math.min(100, paidPercent)
            )}%
          ">
        </i>
      </div>

    </div>

    <div class="metrics">

      <div class="metric">
        <small>Original Loan</small>
        <strong>
          ${M(original)}
        </strong>
      </div>

      <div class="metric">
        <small>Principal Paid</small>
        <strong>
          ${M(principalPaid)}
        </strong>
      </div>

      <div class="metric">
        <small>Interest Paid</small>
        <strong>
          ${M(result.interestPaid)}
        </strong>
      </div>

      <div class="metric">
        <small>Extra Paid</small>
        <strong>
          ${M(result.extraPaid)}
        </strong>
      </div>

    </div>

    <div class="card">

      <div class="pt">

        <h2>Loan Summary</h2>

        <span class="pill">
          ${loan.annual_rate}% ·
          ${loan.tenure_months} months
        </span>

      </div>

      <div class="row">
        <span>Overall EMI</span>
        <b>${M(overallEMI())}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${M(remaining)}</b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>${paidPercent.toFixed(2)}%</b>
      </div>

      ${
        result.unpaidInterest > 0
          ? `
            <div class="row">
              <span>Unpaid interest</span>
              <b>
                ${M(result.unpaidInterest)}
              </b>
            </div>
          `
          : ""
      }

    </div>

    <div class="card">

      <div class="pt">
        <h2>Contributions</h2>
      </div>

      ${
        bs.length
          ? bs.map(b => {

              const s =
                personStats(b.id);

              const contributionPercent =
                totalContribution > 0
                  ? (
                      s.totalPaid /
                      totalContribution
                    ) * 100
                  : 0;

              return `
                <div class="person">

                  <div class="pt">

                    <b>
                      ${esc(b.name)}
                    </b>

                    <span class="pill">
                      ${M(b.scheduled_emi)}/mo
                    </span>

                  </div>

                  <div class="muted">
                    Total paid
                  </div>

                  <div class="bal">
                    ${M(s.totalPaid)}
                  </div>

                  <div class="bar">
                    <i
                      style="
                        width:${Math.min(
                          100,
                          contributionPercent
                        )}%
                      ">
                    </i>
                  </div>

                  <div class="muted">
                    EMI:
                    ${M(s.emiPaid)}
                    · Extra:
                    ${M(s.extraPaid)}
                    ·
                    ${contributionPercent.toFixed(2)}%
                    of total paid
                  </div>

                </div>
              `;

            }).join("")
          : `
            <div class="empty">
              No borrowers added yet.
            </div>
          `
      }

    </div>

    ${
      edit()
        ? `
          <div class="actions">

            <button
              class="btn primary"
              onclick="payment()">
              ＋ Add Payment
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

/* =========================================================
   PAYMENTS
   ========================================================= */

function payments() {

  if (!$("payments")) return;

  const months =
    [
      ...new Set(
        ps.map(
          p => Number(p.month_no)
        )
      )
    ].sort((a, b) => b - a);

  $("payments").innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>Payments</h2>

          <div class="muted">
            ${months.length}
            month(s) recorded
          </div>
        </div>

        ${
          edit()
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
          ? months.map(monthNo => {

              const rows =
                ps.filter(
                  p =>
                    Number(p.month_no) ===
                    Number(monthNo)
                );

              const emiTotal =
                rows.reduce(
                  (s, p) =>
                    s +
                    (Number(p.emi_paid) || 0),
                  0
                );

              const extraTotal =
                rows.reduce(
                  (s, p) =>
                    s +
                    (Number(p.extra_principal) || 0),
                  0
                );

              const result =
                calculateLoan(monthNo);

              return `
                <div
                  class="row"
                  style="cursor:pointer"
                  onclick="editMonth(${monthNo})">

                  <div>

                    <b>
                      ${monthLabel(monthNo)}
                    </b>

                    <div class="muted">
                      EMI ${M(emiTotal)}
                      · Extra ${M(extraTotal)}
                    </div>

                  </div>

                  <div style="text-align:right">

                    <span class="pill">
                      Balance
                      ${M(result.balance)}
                    </span>

                    ${
                      edit()
                        ? `
                          <div class="muted">
                            ✏️ Edit
                          </div>
                        `
                        : ""
                    }

                  </div>

                </div>
              `;

            }).join("")
          : `
            <div class="empty">
              No payments recorded yet.
            </div>
          `
      }

    </div>
  `;
}

/* =========================================================
   PEOPLE
   ========================================================= */

function people() {

  if (!$("people")) return;

  $("people").innerHTML = `

    <div class="card">

      <div class="pt">

        <h2>People</h2>

        ${
          edit()
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
        bs.length
          ? bs.map(b => {

              const s =
                personStats(b.id);

              return `
                <div class="row">

                  <div>

                    <b>
                      ${esc(b.name)}
                    </b>

                    <div class="muted">
                      Fixed EMI:
                      ${M(b.scheduled_emi)}
                    </div>

                    <div class="muted">
                      Total paid:
                      ${M(s.totalPaid)}
                    </div>

                  </div>

                  ${
                    edit()
                      ? `
                        <button
                          class="btn soft"
                          onclick="
                            person('${b.id}')
                          ">
                          Edit
                        </button>
                      `
                      : ""
                  }

                </div>
              `;

            }).join("")
          : `
            <div class="empty">
              No people added.
            </div>
          `
      }

    </div>
  `;
}

/* =========================================================
   REPORTS
   ========================================================= */

function reports() {

  if (!$("reports")) return;

  if (!loan) {
    $("reports").innerHTML = `
      <div class="card">
        <div class="empty">
          No loan available.
        </div>
      </div>
    `;
    return;
  }

  const result =
    calculateLoan(
      Number(loan.tenure_months)
    );

  const original =
    Number(loan.total_amount) || 0;

  const paid =
    result.principalPaid;

  const remaining =
    Math.max(
      0,
      original - paid
    );

  const percent =
    original > 0
      ? Math.min(
          100,
          paid / original * 100
        )
      : 0;

  $("reports").innerHTML = `

    <div class="card">

      <h2>Loan Report</h2>

      <div class="row">
        <span>Original loan</span>
        <b>${M(original)}</b>
      </div>

      <div class="row">
        <span>Principal paid</span>
        <b>${M(paid)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${M(remaining)}</b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>${percent.toFixed(2)}%</b>
      </div>

      <div class="row">
        <span>Interest paid</span>
        <b>${M(result.interestPaid)}</b>
      </div>

      <div class="row">
        <span>Extra principal</span>
        <b>${M(result.extraPaid)}</b>
      </div>

      <div class="row">
        <span>Total money paid</span>
        <b>${M(result.totalPaid)}</b>
      </div>

      ${
        result.unpaidInterest > 0
          ? `
            <div class="row">
              <span>Unpaid interest</span>
              <b>
                ${M(result.unpaidInterest)}
              </b>
            </div>
          `
          : ""
      }

    </div>

    <div class="card">

      <h2>Person Contributions</h2>

      ${
        bs.map(b => {

          const s =
            personStats(b.id);

          const percentage =
            result.totalPaid > 0
              ? (
                  s.totalPaid /
                  result.totalPaid
                ) * 100
              : 0;

          return `
            <div class="person">

              <div class="pt">
                <b>${esc(b.name)}</b>

                <span class="pill">
                  ${percentage.toFixed(2)}%
                </span>
              </div>

              <div class="row">
                <span>Fixed EMI</span>
                <b>
                  ${M(b.scheduled_emi)}
                </b>
              </div>

              <div class="row">
                <span>EMI paid</span>
                <b>
                  ${M(s.emiPaid)}
                </b>
              </div>

              <div class="row">
                <span>Extra paid</span>
                <b>
                  ${M(s.extraPaid)}
                </b>
              </div>

              <div class="row">
                <span>Total contribution</span>
                <b>
                  ${M(s.totalPaid)}
                </b>
              </div>

            </div>
          `;

        }).join("")
      }

    </div>
  `;
}

/* =========================================================
   MORE
   ========================================================= */

function more() {

  if (!$("more")) return;

  $("more").innerHTML = `

    <div class="card">

      <h2>Account</h2>

      <div class="muted">

        ${
          user
            ? `
              Signed in as
              <b>${esc(user.email)}</b>
            `
            : `
              Public view mode.
              Only the owner can edit.
            `
        }

      </div>

      ${
        user
          ? `
            <button
              class="btn soft"
              onclick="accountPopup()">
              Account
            </button>
          `
          : `
            <p class="muted">
              Use the person icon in the
              top-right corner to sign in.
            </p>
          `
      }

    </div>

    ${
      edit()
        ? `
          <div class="card">

            <h2>Manage</h2>

            <div class="row">

              <b>Loan settings</b>

              <button
                class="btn soft"
                onclick="loanEdit()">
                Open
              </button>

            </div>

            <div class="row">

              <b>Payment history</b>

              <button
                class="btn soft"
                onclick="history()">
                Open
              </button>

            </div>

            <div class="row">

              <b>Reset loan</b>

              <button
                class="btn danger"
                onclick="resetLoan()">
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
   MODAL
   ========================================================= */

function modal(html) {

  if (!$("modal")) return;

  $("mb").innerHTML = html;

  $("modal").classList.add("open");
}

function close() {

  if (!$("modal")) return;

  $("modal").classList.remove("open");
}

if ($("x")) {
  $("x").onclick = close;
}

if ($("modal")) {

  $("modal").onclick = e => {

    if (e.target === $("modal")) {
      close();
    }

  };
}

/* =========================================================
   OWNER ACCOUNT POPUP
   ========================================================= */

function accountPopup() {

  if (!user) {
    auth();
    return;
  }

  modal(`

    <div class="account-popup">

      <div class="popup-icon">
        👤
      </div>

      <h2>Owner Account</h2>

      <p class="muted">
        ${esc(user.email)}
      </p>

      <div class="card mini">

        <div class="row">
          <span>Status</span>
          <b>Owner</b>
        </div>

        <div class="row">
          <span>Access</span>
          <b>Edit enabled</b>
        </div>

      </div>

      <button
        class="btn danger"
        onclick="out()">
        Sign out
      </button>

    </div>
  `);
}

/* =========================================================
   AUTH
   ========================================================= */

function auth() {

  if (user) {
    accountPopup();
    return;
  }

  modal(`

    <div class="account-popup">

      <div class="popup-icon">
        🔐
      </div>

      <h2>Owner Sign In</h2>

      <p class="muted">
        Public users can view the loan.
        Only the owner can edit it.
      </p>

      <label>
        Email
        <input
          id="ae"
          type="email"
          placeholder="Owner email"
          autocomplete="email">
      </label>

      <label>
        Password
        <input
          id="ap"
          type="password"
          placeholder="Password"
          autocomplete="current-password">
      </label>

      <button
        class="btn primary"
        onclick="login()">
        Sign in
      </button>

      <button
        class="btn soft"
        onclick="signup()">
        Create owner account
      </button>

    </div>
  `);
}

/* =========================================================
   LOGIN
   ========================================================= */

async function login() {

  if (!db) {
    toast(
      "Cloud is not configured.",
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

  const q =
    await db.auth.signInWithPassword({
      email,
      password
    });

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  user = q.data.user;

  toast(
    "✓ Signed in successfully",
    "success"
  );

  await load();
}

/* =========================================================
   SIGN UP
   ========================================================= */

async function signup() {

  if (!db) {
    toast(
      "Cloud is not configured.",
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

  if (password.length < 6) {
    toast(
      "Password must be at least 6 characters.",
      "error"
    );
    return;
  }

  const q =
    await db.auth.signUp({
      email,
      password
    });

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  if (q.data?.session) {

    user = q.data.user;

    toast(
      "✓ Owner account created",
      "success"
    );

    await load();

  } else {

    toast(
      "✓ Account created. Check your email.",
      "success"
    );

  }
}

/* =========================================================
   SIGN OUT
   ========================================================= */

async function out() {

  if (!db) return;

  const q =
    await db.auth.signOut();

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  user = null;

  toast(
    "✓ Signed out",
    "success"
  );

  await load();
}

/* =========================================================
   CREATE LOAN
   ========================================================= */

function loanCreate() {

  if (!user) {
    auth();
    return;
  }

  modal(`

    <h2>Create Dream Home Loan</h2>

    <div class="grid">

      <label class="full">
        Loan name

        <input
          id="cln"
          value="Dream Home Loan">
      </label>

      <label>
        Overall loan amount

        <input
          id="cla"
          type="number"
          value="4500000">
      </label>

      <label>
        Annual interest %

        <input
          id="clr"
          type="number"
          step="0.01"
          value="8.9">
      </label>

      <label>
        Tenure months

        <input
          id="clt"
          type="number"
          value="240">
      </label>

      <label>
        Start date

        <input
          id="cls"
          type="date"
          value="${
            new Date()
              .toISOString()
              .slice(0, 10)
          }">
      </label>

      <label>
        Interest-only months

        <input
          id="cli"
          type="number"
          min="0"
          value="0">
      </label>

      <label>
        EMI mode

        <select id="clm">

          <option value="auto">
            Auto
          </option>

          <option value="manual">
            Manual
          </option>

        </select>

      </label>

      <label>
        Manual EMI

        <input
          id="cle"
          type="number"
          value="">
      </label>

    </div>

    <p class="muted">
      Borrowers and their fixed EMI amounts
      can be added after creating the loan.
    </p>

    <button
      class="btn primary"
      onclick="createLoan()">
      Create Loan
    </button>

  `);
}

/* =========================================================
   SAVE NEW LOAN
   ========================================================= */

async function createLoan() {

  if (!edit() && !user) {
    auth();
    return;
  }

  const v = {

    name:
      $("cln").value.trim() ||
      "Dream Home Loan",

    total_amount:
      Number($("cla").value) || 0,

    annual_rate:
      Number($("clr").value) || 0,

    tenure_months:
      Number($("clt").value) || 0,

    start_date:
      $("cls").value,

    interest_only_months:
      Number($("cli").value) || 0,

    emi_mode:
      $("clm").value,

    manual_emi:
      Number($("cle").value) || 0,

    created_by:
      user.id

  };

  if (v.total_amount <= 0) {
    toast(
      "Enter a valid loan amount.",
      "error"
    );
    return;
  }

  const q =
    await db
      .from("loans")
      .insert(v)
      .select()
      .single();

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  toast(
    "✓ Loan created",
    "success"
  );

  await load();
}

/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function loanEdit() {

  if (!edit()) {
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
          value="${esc(loan.name)}">
      </label>

      <label>
        Overall loan amount

        <input
          id="la"
          type="number"
          value="${loan.total_amount}">
      </label>

      <label>
        Annual interest %

        <input
          id="lr"
          type="number"
          step="0.01"
          value="${loan.annual_rate}">
      </label>

      <label>
        Tenure months

        <input
          id="lt"
          type="number"
          value="${loan.tenure_months}">
      </label>

      <label>
        Start date

        <input
          id="ls"
          type="date"
          value="${loan.start_date || ""}">
      </label>

      <label>
        Interest-only months

        <input
          id="li"
          type="number"
          min="0"
          value="${loan.interest_only_months || 0}">
      </label>

      <label>
        EMI mode

        <select id="lm">

          <option
            value="auto"
            ${
              loan.emi_mode === "auto"
                ? "selected"
                : ""
            }>
            Auto
          </option>

          <option
            value="manual"
            ${
              loan.emi_mode === "manual"
                ? "selected"
                : ""
            }>
            Manual
          </option>

        </select>

      </label>

      <label>
        Manual EMI

        <input
          id="le"
          type="number"
          value="${loan.manual_emi || ""}">
      </label>

    </div>

    <p class="muted">
      Interest is calculated on the common
      remaining loan principal.
    </p>

    <button
      class="btn primary"
      onclick="saveLoan()">
      Save Changes
    </button>

  `);
}

/* =========================================================
   SAVE LOAN
   ========================================================= */

async function saveLoan() {

  if (!edit()) {
    auth();
    return;
  }

  const v = {

    name:
      $("ln").value.trim() ||
      "Dream Home Loan",

    total_amount:
      Number($("la").value) || 0,

    annual_rate:
      Number($("lr").value) || 0,

    tenure_months:
      Number($("lt").value) || 0,

    start_date:
      $("ls").value,

    interest_only_months:
      Number($("li").value) || 0,

    emi_mode:
      $("lm").value,

    manual_emi:
      Number($("le").value) || 0,

    updated_at:
      new Date().toISOString()

  };

  const q =
    await db
      .from("loans")
      .update(v)
      .eq("id", loan.id)
      .select()
      .single();

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  toast(
    "✓ Loan settings saved",
    "success"
  );

  await load();
}

/* =========================================================
   PERSON
   ========================================================= */

function person(id) {

  if (!edit()) {
    auth();
    return;
  }

  const b =
    bs.find(x => x.id === id) || {
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
        value="${esc(b.name)}"
        placeholder="Person name">
    </label>

    <label>
      Fixed Monthly EMI

      <input
        id="be"
        type="number"
        value="${b.scheduled_emi || ""}"
        placeholder="Example: 15000">
    </label>

    <p class="muted">
      This fixed EMI will automatically appear
      when entering monthly payments.
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
            onclick="delPerson('${id}')">
            Delete Person
          </button>
        `
        : ""
    }

  `);
}

/* =========================================================
   SAVE PERSON
   ========================================================= */

async function savePerson(id) {

  if (!edit()) {
    auth();
    return;
  }

  const v = {

    loan_id: loan.id,

    name:
      $("bn").value.trim() ||
      "Person",

    scheduled_emi:
      Number($("be").value) || 0,

    sort_order:
      id
        ? (
            bs.find(
              x => x.id === id
            )?.sort_order || 0
          )
        : bs.length

  };

  let q;

  if (id) {

    q =
      await db
        .from("borrowers")
        .update(v)
        .eq("id", id)
        .select()
        .single();

  } else {

    q =
      await db
        .from("borrowers")
        .insert(v)
        .select()
        .single();

  }

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  toast(
    "✓ Person saved",
    "success"
  );

  await load();
}

/* =========================================================
   DELETE PERSON
   ========================================================= */

async function delPerson(id) {

  if (!edit()) return;

  if (
    !confirm(
      "Delete this person and all their payments?"
    )
  ) {
    return;
  }

  const q =
    await db
      .from("borrowers")
      .delete()
      .eq("id", id);

  if (q.error) {

    toast(
      q.error.message,
      "error"
    );

    return;
  }

  close();

  toast(
    "Person deleted",
    "success"
  );

  await load();
}

/* =========================================================
   PAYMENT ENTRY
   ========================================================= */

function payment(monthNo = null) {

  if (!edit()) {
    auth();
    return;
  }

  if (!loan) return;

  let m = monthNo;

  if (!m) {

    m =
      Number(
        prompt(
          `Enter month number (1-${loan.tenure_months})`,
          "1"
        )
      );

  }

  if (
    !m ||
    m < 1 ||
    m > Number(loan.tenure_months)
  ) {
    return;
  }

  showPaymentModal(m);
}

/* =========================================================
   PAYMENT MODAL
   ========================================================= */

function showPaymentModal(m) {

  const existing =
    ps.filter(
      p =>
        Number(p.month_no) ===
        Number(m)
    );

  const opening =
    calculateLoan(
      Number(m) - 1
    );

  const interest =
    opening.balance *
    monthlyRate();

  modal(`

    <h2>
      ${monthLabel(m)}
    </h2>

    <div class="card mini">

      <div class="row">
        <span>Opening principal</span>
        <b>${M(opening.balance)}</b>
      </div>

      <div class="row">
        <span>Interest for month</span>
        <b>${M(interest)}</b>
      </div>

    </div>

    <p class="muted">
      Fixed EMI is automatically loaded.
      Enter only the extra amount paid by
      each person.
    </p>

    <div id="prs"></div>

    <button
      class="btn primary"
      onclick="savePayment(${m})">
      ✓ Save Payment
    </button>

  `);

  const container = $("prs");

  if (!container) return;

  container.innerHTML = bs.map(b => {

    const e =
      getPayment(m, b.id);

    return `

      <div class="pay">

        <div class="pt">

          <b>
            ${esc(b.name)}
          </b>

          <span class="pill">
            Fixed EMI
            ${M(b.scheduled_emi)}
          </span>

        </div>

        <div class="grid">

          <label>
            EMI paid

            <input
              disabled
              value="${Math.round(
                Number(
                  b.scheduled_emi
                ) || 0
              )}">
          </label>

          <label>
            Extra payment

            <input
              id="x${b.id}"
              type="number"
              min="0"
              value="${
                Number(
                  e.extra_principal
                ) || ""
              }"
              placeholder="0">
          </label>

        </div>

        <div class="muted">

          ${
            Number(m) <=
            Number(
              loan.interest_only_months
            )
              ? `
                Interest-only month:
                EMI does not reduce principal.
              `
              : `
                EMI above interest reduces
                the common principal.
              `
          }

        </div>

      </div>

    `;

  }).join("");
}

/* =========================================================
   SAVE PAYMENT
   ========================================================= */

async function savePayment(m) {

  if (!edit()) {
    auth();
    return;
  }

  /*
    Before saving, calculate current month's
    fixed EMI automatically.
  */

  for (const b of bs) {

    const extra =
      Number(
        $("x" + b.id)?.value
      ) || 0;

    const fixedEMI =
      Number(b.scheduled_emi) || 0;

    const v = {

      loan_id: loan.id,

      borrower_id: b.id,

      month_no: Number(m),

      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      /*
        Fixed EMI is automatically stored.
      */

      emi_paid: fixedEMI,

      /*
        Only extra payment is entered manually.
      */

      extra_principal: extra

    };

    const q =
      await db
        .from("monthly_payments")
        .upsert(
          v,
          {
            onConflict:
              "loan_id,borrower_id,month_no"
          }
        );

    if (q.error) {

      toast(
        q.error.message,
        "error"
      );

      return;
    }
  }

  close();

  toast(
    `✓ ${monthLabel(m)} payment saved`,
    "success"
  );

  await load();
}

/* =========================================================
   EDIT MONTH
   ========================================================= */

function editMonth(m) {

  if (!edit()) {
    return;
  }

  payment(m);
}

/* =========================================================
   PAYMENT HISTORY
   ========================================================= */

function history() {

  if (!loan) return;

  let rows = "";

  const sorted =
    [...ps].sort(
      (a, b) =>
        Number(b.month_no) -
        Number(a.month_no)
    );

  sorted.forEach(p => {

    const b =
      bs.find(
        x => x.id === p.borrower_id
      );

    const result =
      calculateLoan(
        Number(p.month_no)
      );

    rows += `

      <tr>

        <td>
          ${monthLabel(p.month_no)}
        </td>

        <td>
          ${esc(
            b?.name || "Unknown"
          )}
        </td>

        <td>
          ${M(p.emi_paid)}
        </td>

        <td>
          ${M(p.extra_principal)}
        </td>

        <td>
          ${M(result.balance)}
        </td>

        ${
          edit()
            ? `
              <td>
                <button
                  class="btn soft"
                  onclick="
                    close();
                    payment(${p.month_no});
                  ">
                  Edit
                </button>
              </td>
            `
            : ""
        }

      </tr>
    `;
  });

  modal(`

    <h2>Payment History</h2>

    ${
      rows
        ? `
          <div class="table">

            <table>

              <tr>
                <th>Month</th>
                <th>Person</th>
                <th>EMI</th>
                <th>Extra</th>
                <th>Balance</th>
                ${
                  edit()
                    ? "<th></th>"
                    : ""
                }
              </tr>

              ${rows}

            </table>

          </div>
        `
        : `
          <div class="empty">
            No payments saved.
          </div>
        `
    }

  `);
}

/* =========================================================
   RESET LOAN
   ========================================================= */

async function resetLoan() {

  if (!edit()) {
    auth();
    return;
  }

  const answer =
    prompt(
      "Type RESET to delete all payments and borrowers. The loan settings will remain."
    );

  if (answer !== "RESET") {
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

  /*
    Delete borrowers.
  */

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

  close();

  toast(
    "✓ Loan tracking data reset",
    "success"
  );

  await load();
}

/* =========================================================
   AUTH STATE
   ========================================================= */

if (db) {

  db.auth.onAuthStateChange(
    (event, session) => {

      setTimeout(
        async () => {

          user =
            session?.user || null;

          await load();

        },
        0
      );

    }
  );

  load();

} else {

  dashboard();

}

/* =========================================================
   SERVICE WORKER
   ========================================================= */

if (
  "serviceWorker" in navigator
) {

  navigator.serviceWorker
    .register("./sw.js")
    .catch(err =>
      console.log(
        "Service worker:",
        err
      )
    );

}

/* =========================================================
   INITIAL NAVIGATION
   ========================================================= */

nav("dashboard");
