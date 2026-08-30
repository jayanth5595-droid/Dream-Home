const CFG = window.DREAM_HOME || {};

const ready =
  CFG.url &&
  !CFG.url.includes("PASTE_") &&
  CFG.key &&
  !CFG.key.includes("PASTE_");

const db = ready ? supabase.createClient(CFG.url, CFG.key) : null;

let user = null;
let loan = null;
let bs = [];
let ps = [];

const $ = id => document.getElementById(id);

const M = n =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(+n || 0));

const esc = x =>
  String(x ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function toast(message, type = "ok") {
  const t = $("toast");
  if (!t) return;

  t.textContent = message;
  t.className = "toast-" + type;
  t.style.display = "block";

  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    t.style.display = "none";
  }, 2400);
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

/* =========================================================
   LOAN CALCULATIONS
   ========================================================= */

function rate() {
  return (+loan?.annual_rate || 0) / 1200;
}

/* Automatically calculated minimum EMI */
function minimumEMI() {
  if (!loan) return 0;

  const p = +loan.total_amount || 0;
  const n = +loan.tenure_months || 0;
  const r = rate();

  if (!p || !n) return 0;

  if (!r) return p / n;

  return (
    p *
    r *
    Math.pow(1 + r, n) /
    (Math.pow(1 + r, n) - 1)
  );
}

/* Fixed EMI = sum of EMI assigned to all persons */
function fixedEMI() {
  return bs.reduce(
    (sum, b) => sum + (+b.scheduled_emi || 0),
    0
  );
}

/* Payment record for person + EMI month */
function pay(monthNo, borrowerId) {
  return (
    ps.find(
      x =>
        +x.month_no === +monthNo &&
        x.borrower_id === borrowerId
    ) || {
      emi_paid: 0,
      extra_principal: 0
    }
  );
}

/*
   Calculate a person's contribution.

   IMPORTANT:
   Principal is calculated from the FULL LOAN.
   There is NO principal-share concept.

   Regular EMI:
   - During interest-only period -> interest only
   - Afterwards -> interest + principal

   Extra principal:
   - always reduces the full loan principal
   - contribution is attributed to the person who paid it
*/

function calculateLoan(upToMonth = Infinity) {
  if (!loan) {
    return {
      balance: 0,
      principalPaid: 0,
      interestPaid: 0,
      extraPaid: 0,
      totalPaid: 0,
      unpaidInterest: 0
    };
  }

  let balance = +loan.total_amount || 0;
  let principalPaid = 0;
  let interestPaid = 0;
  let extraPaid = 0;
  let totalPaid = 0;
  let unpaidInterest = 0;

  const interestOnly =
    +loan.interest_only_months || 0;

  const months = Math.min(
    upToMonth === Infinity
      ? loan.tenure_months
      : upToMonth,
    loan.tenure_months
  );

  for (let m = 1; m <= months; m++) {
    if (balance <= 0) break;

    const interest = balance * rate();

    let monthEMI = 0;
    let monthExtra = 0;

    ps
      .filter(x => +x.month_no === m)
      .forEach(x => {
        monthEMI += +x.emi_paid || 0;
        monthExtra += +x.extra_principal || 0;
      });

    totalPaid += monthEMI + monthExtra;

    const interestPayment = Math.min(
      monthEMI,
      interest
    );

    interestPaid += interestPayment;

    if (monthEMI < interest) {
      unpaidInterest += interest - monthEMI;
    }

    let principalFromEMI = 0;

    if (m > interestOnly) {
      principalFromEMI = Math.min(
        Math.max(0, monthEMI - interest),
        balance
      );
    }

    balance -= principalFromEMI;
    principalPaid += principalFromEMI;

    const extra = Math.min(
      Math.max(0, monthExtra),
      Math.max(0, balance)
    );

    balance -= extra;
    extraPaid += extra;
  }

  balance = Math.max(0, balance);

  return {
    balance,
    principalPaid,
    interestPaid,
    extraPaid,
    totalPaid,
    unpaidInterest
  };
}

/* =========================================================
   PERSON CALCULATIONS
   ========================================================= */

function personCalculation(person, upToMonth = Infinity) {
  if (!loan) {
    return {
      emiPaid: 0,
      extraPaid: 0,
      totalPaid: 0,
      interestPaid: 0,
      principalPaid: 0,
      contribution: 0
    };
  }

  let emiPaid = 0;
  let extraPaid = 0;
  let interestPaid = 0;
  let principalPaid = 0;

  const months = Math.min(
    upToMonth === Infinity
      ? loan.tenure_months
      : upToMonth,
    loan.tenure_months
  );

  let balance = +loan.total_amount || 0;

  for (let m = 1; m <= months; m++) {
    if (balance <= 0) break;

    const interest = balance * rate();

    const e = pay(m, person.id);

    const emi = +e.emi_paid || 0;
    const extra = +e.extra_principal || 0;

    emiPaid += emi;
    extraPaid += extra;

    const personInterest = Math.min(
      emi,
      interest
    );

    interestPaid += personInterest;

    let principal = 0;

    if (
      m >
      (+loan.interest_only_months || 0)
    ) {
      principal = Math.min(
        Math.max(0, emi - interest),
        balance
      );
    }

    balance -= principal;

    principalPaid += principal;

    const ep = Math.min(
      extra,
      Math.max(0, balance)
    );

    balance -= ep;
    principalPaid += ep;
  }

  const totalPaid = emiPaid + extraPaid;

  const contribution =
    loan.total_amount > 0
      ? (totalPaid / loan.total_amount) * 100
      : 0;

  return {
    emiPaid,
    extraPaid,
    totalPaid,
    interestPaid,
    principalPaid,
    contribution
  };
}

/* =========================================================
   EMI MONTHS
   ========================================================= */

/*
   If loan starts in August 2026,
   first EMI month = September 2026.
*/

function firstEMIMonth() {
  if (!loan?.start_date) return null;

  const d = new Date(
    loan.start_date + "T00:00:00"
  );

  d.setMonth(d.getMonth() + 1);

  return d;
}

function monthDate(monthNo) {
  const first = firstEMIMonth();

  if (!first) return null;

  const d = new Date(first);
  d.setMonth(d.getMonth() + monthNo - 1);

  return d;
}

function monthLabel(monthNo) {
  const d = monthDate(monthNo);

  if (!d) return "Month " + monthNo;

  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric"
  });
}

/*
   Calculate how many EMI months are required
   after extra principal payments.

   This uses the Minimum EMI.
*/

function calculatedTenure() {
  if (!loan) return 0;

  let balance = +loan.total_amount || 0;
  const emi = minimumEMI();
  const r = rate();

  if (balance <= 0) return 0;

  if (!emi) return loan.tenure_months;

  let month = 0;

  while (
    balance > 0.01 &&
    month < 1000
  ) {
    month++;

    const interest = balance * r;

    const principal = Math.min(
      Math.max(0, emi - interest),
      balance
    );

    balance -= principal;

    /*
      Safety against EMI being insufficient.
    */
    if (
      r &&
      emi <= interest &&
      month > 2
    ) {
      return loan.tenure_months;
    }
  }

  return month;
}

/* =========================================================
   EDIT PERMISSION
   ========================================================= */

function edit() {
  return (
    !!user &&
    !!loan &&
    loan.created_by === user.id
  );
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

  const target = $(id);

  if (target) {
    target.classList.add("active");
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

document
  .querySelectorAll("nav button")
  .forEach(x => {
    x.onclick = () =>
      nav(x.dataset.s);
  });

/* =========================================================
   LOAD CLOUD DATA
   ========================================================= */

async function load() {
  if (!db) {
    sync("bad");
    dashboard();
    return;
  }

  sync("");

  try {
    const q =
      await db.auth.getUser();

    user = q.data?.user || null;

    /*
      Owner-created loan is loaded.
      Public users can read it.
    */
    const l =
      await db
        .from("loans")
        .select("*")
        .order("created_at")
        .limit(1)
        .maybeSingle();

    if (l.error) {
      console.error(l.error);
      toast(l.error.message, "bad");
      sync("bad");
      return;
    }

    loan = l.data;

    if (loan) {
      const [b, p] =
        await Promise.all([
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

      if (b.error) {
        toast(b.error.message, "bad");
      }

      if (p.error) {
        toast(p.error.message, "bad");
      }

      bs = b.data || [];
      ps = p.data || [];
    } else {
      bs = [];
      ps = [];
    }

    sync("ok");

    dashboard();

    /*
      Keep account icon behaviour correct.
    */
    updateAccountButton();

  } catch (err) {
    console.error(err);
    toast("Unable to load cloud data", "bad");
    sync("bad");
  }
}

/* =========================================================
   ACCOUNT ICON
   ========================================================= */

function updateAccountButton() {
  const a = $("account");

  if (!a) return;

  a.onclick = () => {
    if (user) {
      modal(`
        <div class="account-popup">
          <div class="popup-icon">👤</div>
          <h2>Owner Account</h2>
          <p class="muted">
            ${esc(user.email || "")}
          </p>

          <button
            class="btn danger"
            onclick="out()">
            Sign out
          </button>
        </div>
      `);
    } else {
      auth();
    }
  };
}

/* =========================================================
   DASHBOARD
   ========================================================= */

function dashboard() {
  if (!loan) {
    $("dashboard").innerHTML = `
      <div class="hero">
        <small>DREAM HOME</small>
        <strong>Cloud Loan Tracker</strong>
        <div>
          Owner sign-in is required to create
          the loan.
        </div>
      </div>

      <div class="card">
        <h2>Cloud setup</h2>

        <p class="muted">
          ${ready
            ? "No loan has been created yet."
            : "Add your Supabase URL and publishable/anon key in config.js and redeploy."
          }
        </p>

        <button
          class="btn primary"
          onclick="auth()">
          🔐 Owner sign in
        </button>
      </div>
    `;

    return;
  }

  const summary =
    calculateLoan();

  const minimum = minimumEMI();
  const fixed = fixedEMI();

  const paidPrincipal =
    summary.principalPaid +
    summary.extraPaid;

  const original =
    +loan.total_amount || 0;

  const remaining =
    Math.max(
      0,
      original - paidPrincipal
    );

  /*
    Loan paid percentage is based on principal.
  */
  const paidPercent =
    original > 0
      ? Math.min(
          100,
          (paidPrincipal / original) * 100
        )
      : 0;

  const totalEMIs =
    +loan.tenure_months || 0;

  /*
    Number of actual EMI months entered.
  */
  const emiMonthsPaid =
    ps.length
      ? Math.max(
          ...ps.map(x => +x.month_no || 0)
        )
      : 0;

  const newTenure =
    calculatedTenure();

  $("dashboard").innerHTML = `

    <div class="hero">
      <small>REMAINING PRINCIPAL</small>

      <strong>${M(remaining)}</strong>

      <div>
        ${M(original)}
        original loan ·
        ${loan.annual_rate}% ·
        ${loan.tenure_months} months
      </div>
    </div>

    <!-- EMI CELLS -->

    <div class="metrics">

      <div class="metric">
        <small>Minimum EMI</small>
        <strong>${M(minimum)}</strong>
      </div>

      <div class="metric">
        <small>Fixed EMI</small>
        <strong>${M(fixed)}</strong>
      </div>

    </div>

    <!-- EMI PROGRESS -->

    <div class="card">

      <div class="pt">
        <div>
          <h2>EMI Progress</h2>
          <div class="muted">
            ${emiMonthsPaid}
            of
            ${totalEMIs}
            EMIs
          </div>
        </div>

        <span class="pill">
          ${Math.min(
            100,
            totalEMIs
              ? (emiMonthsPaid /
                  totalEMIs) *
                100
              : 0
          ).toFixed(0)}%
        </span>
      </div>

      <div class="bar">
        <i style="
          width:${Math.min(
            100,
            totalEMIs
              ? (emiMonthsPaid /
                  totalEMIs) *
                100
              : 0
          )}%
        "></i>
      </div>

    </div>

    <!-- LOAN PAID PROGRESS -->

    <div class="card">

      <div class="pt">
        <div>
          <h2>Loan Paid</h2>
          <div class="muted">
            Principal repayment
          </div>
        </div>

        <strong>
          ${paidPercent.toFixed(1)}%
        </strong>
      </div>

      <div class="bar">
        <i style="
          width:${paidPercent}%
        "></i>
      </div>

      <div class="muted">
        ${M(paidPrincipal)}
        principal paid ·
        ${M(remaining)}
        remaining
      </div>

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
  if (!loan) {
    $("payments").innerHTML = `
      <div class="card empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  const months = [
    ...new Set(
      ps.map(x => +x.month_no)
    )
  ].sort((a, b) => b - a);

  $("payments").innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>Payments</h2>

          <div class="muted">
            Enter actual EMI and extra
            principal paid by each person.
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

    </div>

    ${
      months
        .map(m => {

          const q =
            ps.filter(
              x => +x.month_no === +m
            );

          const emi =
            q.reduce(
              (a, x) =>
                a + (+x.emi_paid || 0),
              0
            );

          const extra =
            q.reduce(
              (a, x) =>
                a +
                (+x.extra_principal || 0),
              0
            );

          return `
            <div class="card">

              <div class="pt">

                <div>
                  <h2>
                    ${monthLabel(m)}
                  </h2>

                  <div class="muted">
                    EMI ${M(emi)}
                    · Extra ${M(extra)}
                  </div>
                </div>

                ${
                  edit()
                    ? `
                      <button
                        class="btn soft"
                        onclick="payment(${m})">
                        Edit
                      </button>
                    `
                    : `
                      <span class="pill">
                        Saved
                      </span>
                    `
                }

              </div>

            </div>
          `;
        })
        .join("")
      ||
      `
        <div class="card empty">
          No payments recorded yet.
        </div>
      `
    }

  `;
}

/* =========================================================
   PEOPLE
   ========================================================= */

function people() {
  if (!loan) return;

  $("people").innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>People</h2>
          <div class="muted">
            Individual payment contribution
          </div>
        </div>

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

    </div>

    ${
      bs
        .map(b => {

          const c =
            personCalculation(b);

          return `
            <div class="card person-card">

              <div class="pt">
                <h2>
                  ${esc(b.name)}
                </h2>

                <span class="pill">
                  ${M(b.scheduled_emi)}
                  / month
                </span>
              </div>

              <div class="row">
                <span>EMI amount paid</span>
                <b>${M(c.emiPaid)}</b>
              </div>

              <div class="row">
                <span>Extra principal paid</span>
                <b>${M(c.extraPaid)}</b>
              </div>

              <div class="row">
                <span>Total amount paid</span>
                <b>${M(c.totalPaid)}</b>
              </div>

              <div class="row">
                <span>Payment contribution</span>
                <b>
                  ${c.contribution.toFixed(2)}%
                </b>
              </div>

              ${
                edit()
                  ? `
                    <button
                      class="btn soft"
                      onclick="person('${b.id}')">
                      Edit Person
                    </button>
                  `
                  : ""
              }

            </div>
          `;
        })
        .join("")
      ||
      `
        <div class="card empty">
          No people added.
        </div>
      `
    }

  `;
}

/* =========================================================
   REPORTS
   ========================================================= */

function reports() {
  if (!loan) {
    $("reports").innerHTML = `
      <div class="card empty">
        No loan created yet.
      </div>
    `;
    return;
  }

  const summary =
    calculateLoan();

  const original =
    +loan.total_amount || 0;

  const principalPaid =
    summary.principalPaid +
    summary.extraPaid;

  const remaining =
    Math.max(
      0,
      original - principalPaid
    );

  const paidPercent =
    original
      ? (principalPaid / original) * 100
      : 0;

  $("reports").innerHTML = `

    <div class="card">

      <h2>Loan Summary</h2>

      <div class="row">
        <span>Original loan</span>
        <b>${M(original)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${M(remaining)}</b>
      </div>

      <div class="row">
        <span>Principal paid</span>
        <b>${M(principalPaid)}</b>
      </div>

      <div class="row">
        <span>Interest paid</span>
        <b>${M(summary.interestPaid)}</b>
      </div>

      <div class="row">
        <span>Extra principal paid</span>
        <b>${M(summary.extraPaid)}</b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>
          ${Math.min(
            100,
            paidPercent
          ).toFixed(1)}%
        </b>
      </div>

      <div class="row">
        <span>Interest-only period</span>
        <b>
          ${loan.interest_only_months || 0}
          months
        </b>
      </div>

      <div class="row">
        <span>Minimum EMI</span>
        <b>${M(minimumEMI())}</b>
      </div>

      <div class="row">
        <span>Fixed EMI</span>
        <b>${M(fixedEMI())}</b>
      </div>

      <div class="row">
        <span>Original tenure</span>
        <b>
          ${loan.tenure_months}
          months
        </b>
      </div>

      <div class="row">
        <span>Current calculated tenure</span>
        <b>
          ${calculatedTenure()}
          months
        </b>
      </div>

    </div>

    <h2 class="section-title">
      Individual Contributions
    </h2>

    ${
      bs
        .map(b => {

          const c =
            personCalculation(b);

          return `
            <div class="card person-card">

              <div class="pt">
                <h2>
                  ${esc(b.name)}
                </h2>

                <span class="pill">
                  ${c.contribution.toFixed(2)}%
                </span>
              </div>

              <div class="row">
                <span>EMI amount paid</span>
                <b>${M(c.emiPaid)}</b>
              </div>

              <div class="row">
                <span>Extra principal paid</span>
                <b>${M(c.extraPaid)}</b>
              </div>

              <div class="row">
                <span>Total amount paid</span>
                <b>${M(c.totalPaid)}</b>
              </div>

              <div class="row">
                <span>Interest paid</span>
                <b>${M(c.interestPaid)}</b>
              </div>

              <div class="row">
                <span>Principal contribution</span>
                <b>${M(c.principalPaid)}</b>
              </div>

              <div class="row">
                <span>Payment contribution</span>
                <b>
                  ${c.contribution.toFixed(2)}%
                </b>
              </div>

            </div>
          `;
        })
        .join("")
      :
      `
        <div class="card empty">
          No people added.
        </div>
      `
    }

  `;
}

/* =========================================================
   MORE
   ========================================================= */

function more() {
  $("more").innerHTML = `

    <div class="card">

      <h2>Account</h2>

      <div class="muted">
        ${
          user
            ? "Signed in as " +
              esc(user.email)
            : "Public view mode — owner only can edit."
        }
      </div>

      <br>

      ${
        user
          ? `
            <button
              class="btn danger"
              onclick="out()">
              Sign out
            </button>
          `
          : `
            <button
              class="btn primary"
              onclick="auth()">
              🔐 Owner sign in
            </button>
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
  $("mb").innerHTML = html;
  $("modal").classList.add("open");
}

function close() {
  $("modal").classList.remove("open");
}

$("x").onclick = close;

$("modal").onclick = e => {
  if (e.target === $("modal")) {
    close();
  }
};

/* =========================================================
   AUTH
   ========================================================= */

function auth() {
  if (!db) {
    toast(
      "Supabase is not configured",
      "bad"
    );
    return;
  }

  modal(`

    <div class="auth-popup">

      <div class="popup-icon">
        🔐
      </div>

      <h2>Owner Sign In</h2>

      <p class="muted">
        Only the owner account can edit
        Dream Home cloud data.
      </p>

      <label>
        Email
        <input
          id="ae"
          type="email"
          autocomplete="email"
          placeholder="Owner email">
      </label>

      <label>
        Password
        <input
          id="ap"
          type="password"
          autocomplete="current-password"
          placeholder="Password">
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

async function login() {
  const email =
    $("ae")?.value.trim();

  const password =
    $("ap")?.value;

  if (!email || !password) {
    toast(
      "Enter email and password",
      "bad"
    );
    return;
  }

  const q =
    await db.auth.signInWithPassword({
      email,
      password
    });

  if (q.error) {
    toast(q.error.message, "bad");
    return;
  }

  close();

  toast(
    "✓ Owner signed in successfully"
  );

  await load();
}

async function signup() {
  const email =
    $("ae")?.value.trim();

  const password =
    $("ap")?.value;

  if (!email || !password) {
    toast(
      "Enter email and password",
      "bad"
    );
    return;
  }

  const q =
    await db.auth.signUp({
      email,
      password
    });

  if (q.error) {
    toast(q.error.message, "bad");
    return;
  }

  close();

  toast(
    "✓ Owner account created"
  );

  await load();
}

async function out() {
  if (!db) return;

  const q =
    await db.auth.signOut();

  if (q.error) {
    toast(q.error.message, "bad");
    return;
  }

  user = null;

  close();

  toast(
    "✓ Signed out successfully"
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
          value="${esc(
            loan.name || "Dream Home Loan"
          )}">
      </label>

      <label>
        Total loan
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
        Loan start date
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

    </div>

    <div class="card">

      <b>Calculated Minimum EMI</b>

      <div class="muted">
        Automatically calculated from
        loan amount, interest and tenure.
      </div>

    </div>

    <p class="muted">
      Fixed EMI is managed separately
      for each person under People.
    </p>

    <button
      class="btn primary"
      onclick="saveLoan()">
      Save settings
    </button>

  `);
}

async function saveLoan() {
  const v = {
    name:
      $("ln").value.trim() ||
      "Dream Home Loan",

    total_amount:
      +$("la").value || 0,

    annual_rate:
      +$("lr").value || 0,

    tenure_months:
      +$("lt").value || 0,

    start_date:
      $("ls").value,

    interest_only_months:
      +$("li").value || 0,

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
    toast(q.error.message, "bad");
    return;
  }

  close();

  toast(
    "✓ Loan settings updated"
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
      name: "New Person",
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
        value="${esc(b.name)}">
    </label>

    <label>
      Fixed EMI
      <input
        id="be"
        type="number"
        value="${b.scheduled_emi || 0}">
    </label>

    <p class="muted">
      This is the fixed monthly EMI
      contribution of this person.
    </p>

    <button
      class="btn primary"
      onclick="savePerson('${id || ""}')">
      Save
    </button>

    ${
      id
        ? `
          <button
            class="btn danger"
            onclick="delPerson('${id}')">
            Delete
          </button>
        `
        : ""
    }

  `);
}

async function savePerson(id) {
  const v = {
    loan_id: loan.id,

    name:
      $("bn").value.trim() ||
      "Person",

    scheduled_emi:
      +$("be").value || 0,

    /*
      Principal share intentionally removed.
    */
    sort_order:
      id
        ? (
            bs.find(
              x => x.id === id
            )?.sort_order || 0
          )
        : bs.length
  };

  /*
    Keep share_amount at 0 because
    old database column may still exist.
    It is no longer used by calculations.
  */
  v.share_amount = 0;

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
    toast(q.error.message, "bad");
    return;
  }

  close();

  toast(
    id
      ? "✓ Person updated"
      : "✓ Person added"
  );

  await load();
}

async function delPerson(id) {
  if (
    !confirm(
      "Delete this person and their payments?"
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
    toast(q.error.message, "bad");
    return;
  }

  close();

  toast(
    "✓ Person deleted"
  );

  await load();
}

/* =========================================================
   PAYMENT ENTRY
   ========================================================= */

function payment(existingMonth = null) {
  if (!edit()) {
    auth();
    return;
  }

  if (!bs.length) {
    toast(
      "Add people first",
      "bad"
    );
    return;
  }

  let selectedMonth =
    existingMonth;

  /*
    If editing existing payment,
    use that month.

    Otherwise show a month dropdown.
  */

  const firstMonth =
    firstEMIMonth();

  if (!firstMonth) {
    toast(
      "Set loan start date first",
      "bad"
    );
    return;
  }

  const maxMonths =
    +loan.tenure_months || 0;

  const options = [];

  for (
    let m = 1;
    m <= maxMonths;
    m++
  ) {
    options.push(`
      <option
        value="${m}"
        ${
          +selectedMonth === m
            ? "selected"
            : ""
        }>
        ${monthLabel(m)}
      </option>
    `);
  }

  modal(`

    <h2>
      ${
        selectedMonth
          ? "Edit Payment"
          : "Add Payment"
      }
    </h2>

    <label>
      EMI Month

      <select id="pm">
        ${options.join("")}
      </select>
    </label>

    <p class="muted">
      Fixed EMI is already saved for
      each person. Enter only the
      <b>extra principal</b> paid by
      each person.
    </p>

    <div id="prs"></div>

    <button
      class="btn primary"
      onclick="savePayment()">
      ✓ Save Payment
    </button>

  `);

  $("pm").onchange = () =>
    renderPaymentPeople(
      +$("pm").value
    );

  renderPaymentPeople(
    selectedMonth ||
      +$("pm").value
  );
}

/*
  Display each person's fixed EMI
  and editable extra amount.

  User does NOT have to re-enter
  fixed EMI every month.
*/

function renderPaymentPeople(m) {
  const container = $("prs");

  if (!container) return;

  container.innerHTML =
    bs
      .map(b => {

        const e =
          pay(m, b.id);

        const opening =
          calculateLoanBeforeMonth(m);

        const interest =
          opening.balance * rate();

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
                Fixed EMI
                <input
                  disabled
                  value="${Math.round(
                    b.scheduled_emi || 0
                  )}">
              </label>

              <label>
                Extra principal
                <input
                  id="x${b.id}"
                  type="number"
                  min="0"
                  step="1"
                  value="${
                    e.extra_principal || ""
                  }"
                  placeholder="0">
              </label>

            </div>

            <div class="calc">

              Interest for this month:
              <b>
                ${M(interest)}
              </b>

              <br>

              ${
                m <=
                (+loan.interest_only_months || 0)
                  ? "Interest-only period: fixed EMI is treated according to the interest-only rule."
                  : "Fixed EMI is used automatically. Extra payment reduces the full loan principal."
              }

            </div>

          </div>

        `;
      })
      .join("");
}

/*
   Get loan state immediately before
   a particular EMI month.
*/

function calculateLoanBeforeMonth(
  monthNo
) {
  if (!loan) {
    return {
      balance: 0
    };
  }

  let balance =
    +loan.total_amount || 0;

  for (
    let m = 1;
    m < monthNo;
    m++
  ) {
    if (balance <= 0) break;

    const interest =
      balance * rate();

    let monthEMI = 0;
    let monthExtra = 0;

    ps
      .filter(
        x => +x.month_no === m
      )
      .forEach(x => {
        monthEMI +=
          +x.emi_paid || 0;

        monthExtra +=
          +x.extra_principal || 0;
      });

    let principal = 0;

    if (
      m >
      (+loan.interest_only_months || 0)
    ) {
      principal = Math.min(
        Math.max(
          0,
          monthEMI - interest
        ),
        balance
      );
    }

    balance -= principal;

    const extra =
      Math.min(
        monthExtra,
        Math.max(0, balance)
      );

    balance -= extra;
  }

  return {
    balance:
      Math.max(0, balance)
  };
}

/*
   Save payment.

   Fixed EMI is automatically inserted
   from each person's saved EMI.

   Only extra principal is entered.
*/

async function savePayment() {
  const m =
    +$("pm").value;

  if (!m) {
    toast(
      "Select an EMI month",
      "bad"
    );
    return;
  }

  for (const b of bs) {

    const extra =
      +$(
        "x" + b.id
      ).value || 0;

    /*
      Fixed EMI is automatically used.
    */
    const fixed =
      +b.scheduled_emi || 0;

    const v = {
      loan_id: loan.id,
      borrower_id: b.id,
      month_no: m,
      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      emi_paid: fixed,

      extra_principal:
        extra
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
        "bad"
      );
      return;
    }
  }

  close();

  toast(
    "✓ Payment saved to cloud"
  );

  await load();
}

/* =========================================================
   PAYMENT HISTORY
   ========================================================= */

function history() {
  if (!loan) return;

  let rows = "";

  for (
    let m = 1;
    m <= loan.tenure_months;
    m++
  ) {

    for (const b of bs) {

      const e =
        pay(m, b.id);

      if (
        !e.emi_paid &&
        !e.extra_principal
      ) {
        continue;
      }

      rows += `

        <tr>

          <td>
            ${monthLabel(m)}
          </td>

          <td>
            ${esc(b.name)}
          </td>

          <td>
            ${M(e.emi_paid)}
          </td>

          <td>
            ${M(e.extra_principal)}
          </td>

          <td>
            ${M(
              calculateLoanBeforeMonth(
                m
              ).balance
            )}
          </td>

          ${
            edit()
              ? `
                <td>
                  <button
                    class="btn soft"
                    onclick="payment(${m})">
                    Edit
                  </button>
                </td>
              `
              : ""
          }

        </tr>

      `;
    }
  }

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
                <th>Opening Principal</th>
                ${
                  edit()
                    ? "<th>Edit</th>"
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

  const ok =
    confirm(
      "RESET THE LOAN?\n\n" +
      "This will delete all monthly payments " +
      "and people and reset the loan data.\n\n" +
      "This cannot be undone."
    );

  if (!ok) return;

  const loanId = loan.id;

  /*
    Delete payments first.
  */
  let q =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loanId);

  if (q.error) {
    toast(
      q.error.message,
      "bad"
    );
    return;
  }

  /*
    Delete people.
  */
  q =
    await db
      .from("borrowers")
      .delete()
      .eq("loan_id", loanId);

  if (q.error) {
    toast(
      q.error.message,
      "bad"
    );
    return;
  }

  /*
    Reset loan values.
  */
  q =
    await db
      .from("loans")
      .update({
        total_amount: 0,
        annual_rate: 0,
        tenure_months: 0,
        interest_only_months: 0,
        manual_emi: 0,
        updated_at:
          new Date().toISOString()
      })
      .eq("id", loanId);

  if (q.error) {
    toast(
      q.error.message,
      "bad"
    );
    return;
  }

  close();

  toast(
    "✓ Loan reset successfully"
  );

  await load();
}

/* =========================================================
   SUPABASE AUTH STATE
   ========================================================= */

if (db) {

  db.auth.onAuthStateChange(
    () => {
      setTimeout(
        load,
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
   INITIAL SCREEN
   ========================================================= */

updateAccountButton();
nav("dashboard");
