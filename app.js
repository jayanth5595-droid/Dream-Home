/* =========================================================
   DREAM HOME v3
   Public Read + Owner Only Edit + Cloud Sync
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

const esc = value =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function toast(message, type = "ok") {
  const t = $("toast");

  if (!t) return;

  t.textContent = message;
  t.className = `toast ${type}`;
  t.style.display = "block";

  setTimeout(() => {
    t.style.display = "none";
  }, 2600);
}

function syncStatus(state) {
  const el = $("sync");

  if (!el) return;

  el.className =
    state === "ok"
      ? "ok"
      : state === "bad"
      ? "bad"
      : "";
}

/* =========================================================
   OWNER / ACCESS
   ========================================================= */

function isOwner() {
  return !!user && !!loan && loan.created_by === user.id;
}

/* =========================================================
   LOAN CALCULATIONS
   ========================================================= */

function monthlyRate() {
  return (Number(loan?.annual_rate) || 0) / 1200;
}

/*
   Minimum EMI is calculated from the FULL loan.
*/
function minimumEMI() {
  if (!loan) return 0;

  const principal = Number(loan.total_amount) || 0;
  const months = Number(loan.tenure_months) || 0;
  const r = monthlyRate();

  if (!principal || !months) return 0;

  if (!r) {
    return principal / months;
  }

  return (
    principal *
    r *
    Math.pow(1 + r, months) /
    (Math.pow(1 + r, months) - 1)
  );
}

/*
   Total fixed EMI contribution of all people.
*/
function fixedEMITotal() {
  return borrowers.reduce(
    (sum, b) => sum + (Number(b.scheduled_emi) || 0),
    0
  );
}

/*
   Get payment record.
*/
function getPayment(monthNo, borrowerId) {
  return (
    paymentsData.find(
      p =>
        Number(p.month_no) === Number(monthNo) &&
        p.borrower_id === borrowerId
    ) || {
      emi_paid: 0,
      extra_principal: 0
    }
  );
}

/*
   Get month date based on loan start date.
*/
function monthDate(monthNo) {
  if (!loan?.start_date) return null;

  const d = new Date(`${loan.start_date}T00:00:00`);

  d.setMonth(d.getMonth() + Number(monthNo) - 1);

  return d;
}

function monthLabel(monthNo) {
  const d = monthDate(monthNo);

  if (!d) return `Month ${monthNo}`;

  return d.toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric"
  });
}

/*
   Find the current month number based on today's date.
*/
function currentMonthNumber() {
  if (!loan?.start_date) return 1;

  const start = new Date(`${loan.start_date}T00:00:00`);
  const today = new Date();

  start.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);

  const months =
    (today.getFullYear() - start.getFullYear()) * 12 +
    (today.getMonth() - start.getMonth()) +
    1;

  return Math.max(
    1,
    Math.min(Number(loan.tenure_months) || 1, months)
  );
}

/*
   Calculate full loan balance month by month.

   Important:
   - Interest is calculated on FULL remaining loan.
   - Fixed EMI is automatically included.
   - Any EMI above interest reduces principal.
   - Extra principal is 100% principal.
   - No borrower principal-share calculation.
*/
function calculateLoan(upToMonth = Number(loan?.tenure_months) || 0) {

  let balance = Number(loan?.total_amount) || 0;

  let totalInterestPaid = 0;
  let totalInterestDue = 0;
  let totalRegularPaid = 0;
  let totalExtra = 0;
  let totalPrincipalPaid = 0;

  const monthly = [];

  const interestOnlyMonths =
    Number(loan?.interest_only_months) || 0;

  const minimum = minimumEMI();
  const fixedTotal = fixedEMITotal();

  for (let m = 1; m <= upToMonth; m++) {

    if (balance <= 0) {
      monthly.push({
        month: m,
        opening: 0,
        interest: 0,
        regularPaid: 0,
        principalFromEMI: 0,
        extra: 0,
        closing: 0
      });

      continue;
    }

    const opening = balance;

    const interest = opening * monthlyRate();

    let regularPaid = 0;

    /*
       Fixed EMI is automatically considered paid
       for every month that has a payment record.
    */
    const monthPayments = paymentsData.filter(
      p => Number(p.month_no) === m
    );

    if (monthPayments.length > 0) {
      regularPaid = fixedTotal;
    }

    /*
       If an actual EMI payment has been entered manually
       for old data, use the recorded value if available.
    */
    const recordedRegular = monthPayments.reduce(
      (sum, p) => sum + (Number(p.emi_paid) || 0),
      0
    );

    if (monthPayments.length > 0 && recordedRegular > 0) {
      regularPaid = recordedRegular;
    }

    let principalFromEMI = 0;

    if (m > interestOnlyMonths) {
      principalFromEMI = Math.max(
        0,
        Math.min(balance, regularPaid - interest)
      );
    }

    /*
       During interest-only period regular EMI doesn't
       reduce principal.
    */
    if (m <= interestOnlyMonths) {
      principalFromEMI = 0;
    }

    const extra =
      monthPayments.reduce(
        (sum, p) => sum + (Number(p.extra_principal) || 0),
        0
      );

    const remainingAfterEMI =
      Math.max(0, balance - principalFromEMI);

    const actualExtra =
      Math.min(extra, remainingAfterEMI);

    balance =
      Math.max(
        0,
        remainingAfterEMI - actualExtra
      );

    /*
       Interest paid cannot exceed actual regular payment.
    */
    const interestPaid =
      Math.min(regularPaid, interest);

    totalInterestPaid += interestPaid;
    totalInterestDue += interest;
    totalRegularPaid += regularPaid;
    totalExtra += actualExtra;
    totalPrincipalPaid +=
      principalFromEMI + actualExtra;

    monthly.push({
      month: m,
      opening,
      interest,
      interestPaid,
      regularPaid,
      principalFromEMI,
      extra: actualExtra,
      closing: balance
    });
  }

  return {
    balance,
    totalInterestPaid,
    totalInterestDue,
    totalRegularPaid,
    totalExtra,
    totalPrincipalPaid,
    monthly,
    minimumEMI: minimum,
    fixedEMI: fixedTotal
  };
}

/* =========================================================
   NAVIGATION
   ========================================================= */

function navigate(screenId) {

  document
    .querySelectorAll(".screen")
    .forEach(el => el.classList.remove("active"));

  const screen = $(screenId);

  if (screen) {
    screen.classList.add("active");
  }

  document
    .querySelectorAll("nav button")
    .forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.s === screenId
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
      titles[screenId] || "Dream Home";
  }

  switch (screenId) {
    case "dashboard":
      renderDashboard();
      break;

    case "payments":
      renderPayments();
      break;

    case "people":
      renderPeople();
      break;

    case "reports":
      renderReports();
      break;

    case "more":
      renderMore();
      break;
  }
}

document
  .querySelectorAll("nav button")
  .forEach(button => {
    button.onclick = () =>
      navigate(button.dataset.s);
  });

/* =========================================================
   ACCOUNT ICON
   ========================================================= */

if ($("account")) {
  $("account").onclick = () => {

    if (user) {
      accountMenu();
    } else {
      showAuth();
    }

  };
}

function accountMenu() {

  modal(`
    <div class="account-popup">

      <div class="account-icon">♙</div>

      <h2>Owner Account</h2>

      <p class="muted">
        Signed in as
      </p>

      <div class="email-box">
        ${esc(user?.email || "")}
      </div>

      <button
        class="btn danger"
        onclick="signOutUser()">
        Sign out
      </button>

      <button
        class="btn soft"
        onclick="closeModal()">
        Cancel
      </button>

    </div>
  `);
}

/* =========================================================
   LOAD CLOUD DATA
   ========================================================= */

async function loadData() {

  if (!db) {
    syncStatus("bad");
    renderDashboard();
    return;
  }

  syncStatus("");

  try {

    const authResult =
      await db.auth.getUser();

    user = authResult.data?.user || null;

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
      syncStatus("bad");
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

      const [bResult, pResult] =
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

      if (bResult.error) {
        toast(
          bResult.error.message,
          "error"
        );
      }

      if (pResult.error) {
        toast(
          pResult.error.message,
          "error"
        );
      }

      borrowers = bResult.data || [];
      paymentsData = pResult.data || [];
    }

    syncStatus("ok");

    updateAccountIcon();

    renderDashboard();

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
   ACCOUNT ICON STATE
   ========================================================= */

function updateAccountIcon() {

  const a = $("account");

  if (!a) return;

  a.textContent = user ? "✓" : "♙";

  a.title = user
    ? "Owner account"
    : "Owner sign in";
}

/* =========================================================
   DASHBOARD
   ========================================================= */

function renderDashboard() {

  const el = $("dashboard");

  if (!el) return;

  if (!loan) {

    el.innerHTML = `
      <div class="hero">

        <small>DREAM HOME</small>

        <strong>Loan Tracker</strong>

        <div>
          Public view is ready.
          Owner sign-in is required
          to create or manage the loan.
        </div>

      </div>

      <div class="card">

        <h2>Welcome to Dream Home</h2>

        <p class="muted">
          Track principal, interest, EMI,
          extra payments and remaining loan
          balance from any device.
        </p>

        <button
          class="btn primary"
          onclick="showAuth()">
          🔐 Owner Sign in
        </button>

      </div>
    `;

    return;
  }

  const result =
    calculateLoan(
      Number(loan.tenure_months) || 0
    );

  const original =
    Number(loan.total_amount) || 0;

  const remaining =
    Math.max(0, result.balance);

  const paidPrincipal =
    Math.min(
      original,
      result.totalPrincipalPaid
    );

  const paidPercent =
    original > 0
      ? (paidPrincipal / original) * 100
      : 0;

  const fixedEMI =
    fixedEMITotal();

  const minimum =
    minimumEMI();

  el.innerHTML = `

    <div class="hero">

      <small>REMAINING PRINCIPAL</small>

      <strong>${money(remaining)}</strong>

      <div>
        ${paidPercent.toFixed(1)}% loan paid
      </div>

      <div class="progress-large">
        <i style="width:${Math.min(
          100,
          Math.max(0, paidPercent)
        )}%"></i>
      </div>

    </div>

    <div class="metrics">

      <div class="metric">
        <small>Principal Paid</small>
        <strong>${money(paidPrincipal)}</strong>
      </div>

      <div class="metric">
        <small>Interest Paid</small>
        <strong>${money(
          result.totalInterestPaid
        )}</strong>
      </div>

      <div class="metric">
        <small>Extra Principal</small>
        <strong>${money(
          result.totalExtra
        )}</strong>
      </div>

      <div class="metric">
        <small>Minimum EMI</small>
        <strong>${money(minimum)}</strong>
        <div class="metric-sub">
          Fixed EMI: ${money(fixedEMI)}
        </div>
      </div>

    </div>

    <div class="card">

      <div class="pt">

        <h2>Loan Summary</h2>

        <span class="pill">
          ${isOwner()
            ? "OWNER"
            : "VIEW ONLY"}
        </span>

      </div>

      <div class="row">
        <span>Original loan</span>
        <b>${money(original)}</b>
      </div>

      <div class="row">
        <span>Interest rate</span>
        <b>${loan.annual_rate}%</b>
      </div>

      <div class="row">
        <span>Tenure</span>
        <b>${loan.tenure_months} months</b>
      </div>

      <div class="row">
        <span>Start date</span>
        <b>${formatDate(loan.start_date)}</b>
      </div>

      <div class="row">
        <span>Minimum EMI</span>
        <b>
          ${money(minimum)}
          <small>
            (Fixed EMI ${money(fixedEMI)})
          </small>
        </b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${money(remaining)}</b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>${paidPercent.toFixed(1)}%</b>
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
              .map(renderPersonCard)
              .join("")
          : `
            <div class="empty">
              No borrowers added yet.
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
              onclick="openPayment()">
              ＋ Add Payment
            </button>

            <button
              class="btn soft"
              onclick="editLoan()">
              ⚙️ Loan Settings
            </button>

          </div>
        `
        : `
          <div class="actions">

            <button
              class="btn soft"
              onclick="showAuth()">
              🔐 Owner Sign in
            </button>

          </div>
        `
    }

  `;
}

/* =========================================================
   PERSON CARD
   ========================================================= */

function renderPersonCard(person) {

  const result =
    calculateLoan(
      Number(loan.tenure_months) || 0
    );

  let totalPaidByPerson = 0;
  let extraByPerson = 0;

  paymentsData
    .filter(
      p => p.borrower_id === person.id
    )
    .forEach(p => {

      totalPaidByPerson +=
        Number(p.emi_paid) || 0;

      extraByPerson +=
        Number(p.extra_principal) || 0;

    });

  /*
     Contribution percentage is based on
     the person's total paid amount compared
     with total paid by everyone.
  */
  const allPaid =
    paymentsData.reduce(
      (sum, p) =>
        sum +
        (Number(p.emi_paid) || 0) +
        (Number(p.extra_principal) || 0),
      0
    );

  const personPaid =
    totalPaidByPerson +
    extraByPerson;

  const contribution =
    allPaid > 0
      ? (personPaid / allPaid) * 100
      : 0;

  return `

    <div class="person">

      <div class="pt">

        <b>${esc(person.name)}</b>

        <span class="pill">
          ${money(person.scheduled_emi)}/mo
        </span>

      </div>

      <div class="muted">
        Fixed EMI contribution
      </div>

      <div class="bal">
        ${money(person.scheduled_emi)}
      </div>

      <div class="row">
        <span>Total paid</span>
        <b>${money(personPaid)}</b>
      </div>

      <div class="row">
        <span>Extra principal</span>
        <b>${money(extraByPerson)}</b>
      </div>

      <div class="row">
        <span>Payment contribution</span>
        <b>${contribution.toFixed(1)}%</b>
      </div>

      <div class="bar">
        <i style="width:${Math.min(
          100,
          Math.max(0, contribution)
        )}%"></i>
      </div>

    </div>
  `;
}

/* =========================================================
   PAYMENTS SCREEN
   ========================================================= */

function renderPayments() {

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

  const months = [
    ...new Set(
      paymentsData.map(
        p => Number(p.month_no)
      )
    )
  ].sort((a, b) => a - b);

  el.innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>Payments</h2>

          <div class="muted">
            Record extra principal
            paid by each person.
          </div>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="btn primary"
                onclick="openPayment()">
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

      ${
        months.length
          ? months
              .slice()
              .reverse()
              .map(renderPaymentMonth)
              .join("")
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
   PAYMENT MONTH CARD
   ========================================================= */

function renderPaymentMonth(monthNo) {

  const monthPayments =
    paymentsData.filter(
      p =>
        Number(p.month_no) ===
        Number(monthNo)
    );

  const totalEMI =
    monthPayments.reduce(
      (sum, p) =>
        sum + (Number(p.emi_paid) || 0),
      0
    );

  const totalExtra =
    monthPayments.reduce(
      (sum, p) =>
        sum +
        (Number(p.extra_principal) || 0),
      0
    );

  return `

    <div class="row payment-month">

      <div>

        <b>${monthLabel(monthNo)}</b>

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
              onclick="openPayment(${monthNo})">
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
  `;
}

/* =========================================================
   PEOPLE SCREEN
   ========================================================= */

function renderPeople() {

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

  el.innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>People</h2>

          <div class="muted">
            Fixed monthly EMI contribution
          </div>
        </div>

        ${
          isOwner()
            ? `
              <button
                class="btn soft"
                onclick="openPerson()">
                ＋ Add
              </button>
            `
            : ""
        }

      </div>

      ${
        borrowers.length
          ? borrowers
              .map(person => `

                <div class="row">

                  <div>

                    <b>${esc(person.name)}</b>

                    <div class="muted">
                      Fixed EMI:
                      ${money(person.scheduled_emi)}
                    </div>

                  </div>

                  ${
                    isOwner()
                      ? `
                        <button
                          class="btn soft"
                          onclick="openPerson('${person.id}')">
                          Edit
                        </button>
                      `
                      : ""
                  }

                </div>

              `)
              .join("")
          : `
            <div class="empty">
              No people added.
            </div>
          `
      }

    </div>

    <div class="card">

      <h2>EMI Summary</h2>

      <div class="row">
        <span>Minimum EMI</span>
        <b>${money(minimumEMI())}</b>
      </div>

      <div class="row">
        <span>Fixed EMI from people</span>
        <b>${money(fixedEMITotal())}</b>
      </div>

      <div class="row">
        <span>Amount above minimum EMI</span>
        <b>
          ${money(
            Math.max(
              0,
              fixedEMITotal() -
                minimumEMI()
            )
          )}
        </b>
      </div>

      <p class="muted">
        If the combined fixed EMI is higher
        than the minimum EMI, the excess
        automatically contributes toward
        principal reduction.
      </p>

    </div>
  `;
}

/* =========================================================
   REPORTS
   ========================================================= */

function renderReports() {

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

  const result =
    calculateLoan(
      Number(loan.tenure_months) || 0
    );

  const original =
    Number(loan.total_amount) || 0;

  const principalPaid =
    Math.min(
      original,
      result.totalPrincipalPaid
    );

  const percent =
    original > 0
      ? principalPaid / original * 100
      : 0;

  el.innerHTML = `

    <div class="card">

      <h2>Loan Summary</h2>

      <div class="row">
        <span>Original loan</span>
        <b>${money(original)}</b>
      </div>

      <div class="row">
        <span>Principal paid</span>
        <b>${money(principalPaid)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${money(result.balance)}</b>
      </div>

      <div class="row">
        <span>Interest paid</span>
        <b>
          ${money(
            result.totalInterestPaid
          )}
        </b>
      </div>

      <div class="row">
        <span>Extra principal paid</span>
        <b>${money(result.totalExtra)}</b>
      </div>

      <div class="row">
        <span>Loan paid</span>
        <b>${percent.toFixed(1)}%</b>
      </div>

    </div>

    <div class="card">

      <h2>EMI</h2>

      <div class="row">
        <span>Minimum EMI</span>
        <b>${money(minimumEMI())}</b>
      </div>

      <div class="row">
        <span>Fixed EMI</span>
        <b>${money(fixedEMITotal())}</b>
      </div>

      <div class="row">
        <span>Fixed EMI excess</span>
        <b>
          ${money(
            Math.max(
              0,
              fixedEMITotal() -
                minimumEMI()
            )
          )}
        </b>
      </div>

      <p class="muted">
        Interest is recalculated every month
        using the full remaining loan principal.
      </p>

    </div>

    <div class="card">

      <h2>Person Contribution</h2>

      ${
        borrowers.length
          ? borrowers
              .map(person => {

                const personPayments =
                  paymentsData.filter(
                    p =>
                      p.borrower_id ===
                      person.id
                  );

                const emi =
                  personPayments.reduce(
                    (sum, p) =>
                      sum +
                      (Number(p.emi_paid) || 0),
                    0
                  );

                const extra =
                  personPayments.reduce(
                    (sum, p) =>
                      sum +
                      (Number(
                        p.extra_principal
                      ) || 0),
                    0
                  );

                const total =
                  emi + extra;

                const all =
                  paymentsData.reduce(
                    (sum, p) =>
                      sum +
                      (Number(p.emi_paid) || 0) +
                      (Number(
                        p.extra_principal
                      ) || 0),
                    0
                  );

                const pct =
                  all > 0
                    ? total / all * 100
                    : 0;

                return `

                  <div class="person">

                    <div class="pt">

                      <b>
                        ${esc(person.name)}
                      </b>

                      <span class="pill">
                        ${pct.toFixed(1)}%
                      </span>

                    </div>

                    <div class="row">
                      <span>EMI paid</span>
                      <b>${money(emi)}</b>
                    </div>

                    <div class="row">
                      <span>Extra principal</span>
                      <b>${money(extra)}</b>
                    </div>

                    <div class="row">
                      <span>Total contribution</span>
                      <b>${money(total)}</b>
                    </div>

                  </div>

                `;
              })
              .join("")
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
   MORE
   ========================================================= */

function renderMore() {

  const el = $("more");

  if (!el) return;

  el.innerHTML = `

    <div class="card">

      <h2>Account</h2>

      ${
        user
          ? `
            <p class="muted">
              Owner signed in as
              <b>${esc(user.email)}</b>
            </p>

            <button
              class="btn danger"
              onclick="signOutUser()">
              Sign out
            </button>
          `
          : `
            <p class="muted">
              Public view mode.
              Only the owner can edit data.
            </p>

            <button
              class="btn primary"
              onclick="showAuth()">
              🔐 Owner Sign in
            </button>
          `
      }

    </div>

    ${
      loan
        ? `
          <div class="card">

            <h2>Loan</h2>

            <div class="row">
              <span>Loan amount</span>
              <b>${money(loan.total_amount)}</b>
            </div>

            <div class="row">
              <span>Interest</span>
              <b>${loan.annual_rate}%</b>
            </div>

            <div class="row">
              <span>Tenure</span>
              <b>${loan.tenure_months} months</b>
            </div>

          </div>
        `
        : ""
    }

    ${
      isOwner()
        ? `
          <div class="card danger-card">

            <h2>Danger Zone</h2>

            <p class="muted">
              Resetting the loan permanently removes
              the loan, people and payment records
              from the cloud.
            </p>

            <button
              class="btn danger"
              onclick="resetLoan()">
              🗑️ Reset Loan
            </button>

          </div>
        `
        : ""
    }

  `;
}

/* =========================================================
   AUTH
   ========================================================= */

function showAuth() {

  if (!db) {
    toast(
      "Supabase configuration is missing.",
      "error"
    );
    return;
  }

  modal(`

    <div class="auth-popup">

      <div class="account-icon">
        🔐
      </div>

      <h2>Owner Sign in</h2>

      <p class="muted">
        Only the owner account can edit
        Dream Home data.
      </p>

      <label>
        Email
        <input
          id="authEmail"
          type="email"
          autocomplete="email"
          placeholder="Enter email">
      </label>

      <label>
        Password
        <input
          id="authPassword"
          type="password"
          autocomplete="current-password"
          placeholder="Enter password">
      </label>

      <button
        class="btn primary"
        onclick="loginUser()">
        Sign in
      </button>

      <button
        class="btn soft"
        onclick="createOwnerAccount()">
        Create owner account
      </button>

    </div>

  `);
}

async function loginUser() {

  if (!db) return;

  const email =
    $("authEmail")?.value.trim();

  const password =
    $("authPassword")?.value;

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
    "✓ Welcome back, owner!",
    "success"
  );

  await loadData();
}

async function createOwnerAccount() {

  if (!db) return;

  const email =
    $("authEmail")?.value.trim();

  const password =
    $("authPassword")?.value;

  if (!email || !password) {

    toast(
      "Enter email and password.",
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
    "✓ Owner account created!",
    "success"
  );

  await loadData();
}

async function signOutUser() {

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

  toast(
    "✓ Signed out successfully",
    "success"
  );

  user = null;

  await loadData();
}

/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function editLoan() {

  if (!isOwner()) {
    showAuth();
    return;
  }

  modal(`

    <h2>Loan Settings</h2>

    <div class="grid">

      <label class="full">
        Loan Name
        <input
          id="loanName"
          value="${esc(
            loan.name || "Dream Home Loan"
          )}">
      </label>

      <label>
        Total Loan
        <input
          id="loanAmount"
          type="number"
          value="${loan.total_amount}">
      </label>

      <label>
        Annual Interest %
        <input
          id="loanRate"
          type="number"
          step="0.01"
          value="${loan.annual_rate}">
      </label>

      <label>
        Tenure (months)
        <input
          id="loanTenure"
          type="number"
          value="${loan.tenure_months}">
      </label>

      <label>
        Start Date
        <input
          id="loanStart"
          type="date"
          value="${loan.start_date || ""}">
      </label>

      <label>
        Interest-only Period
        <input
          id="loanInterestOnly"
          type="number"
          min="0"
          value="${loan.interest_only_months || 0}">
      </label>

    </div>

    <p class="muted">
      Minimum EMI is calculated automatically
      from the full loan amount, interest rate
      and tenure.
    </p>

    <button
      class="btn primary"
      onclick="saveLoanSettings()">
      Save Loan
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
      Number($("loanAmount").value) || 0,

    annual_rate:
      Number($("loanRate").value) || 0,

    tenure_months:
      Number($("loanTenure").value) || 0,

    start_date:
      $("loanStart").value,

    interest_only_months:
      Number(
        $("loanInterestOnly").value
      ) || 0,

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
    "✓ Loan settings saved",
    "success"
  );

  await loadData();
}

/* =========================================================
   PEOPLE
   ========================================================= */

function openPerson(id = "") {

  if (!isOwner()) {
    showAuth();
    return;
  }

  const person =
    borrowers.find(
      b => b.id === id
    ) || {
      name: "",
      scheduled_emi: 0
    };

  modal(`

    <h2>
      ${id ? "Edit Person" : "Add Person"}
    </h2>

    <label>
      Name
      <input
        id="personName"
        value="${esc(person.name)}"
        placeholder="Person name">
    </label>

    <label>
      Fixed Monthly EMI
      <input
        id="personEMI"
        type="number"
        value="${person.scheduled_emi || ""}"
        placeholder="15000">
    </label>

    <p class="muted">
      This fixed EMI is automatically recorded
      whenever a payment month is saved.
      You do not need to enter the fixed EMI
      every month.
    </p>

    <button
      class="btn primary"
      onclick="savePerson('${id}')">
      Save
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

  const name =
    $("personName").value.trim() ||
    "Person";

  const emi =
    Number($("personEMI").value) || 0;

  if (!emi) {

    toast(
      "Enter the fixed monthly EMI.",
      "error"
    );

    return;
  }

  const values = {

    loan_id: loan.id,

    name,

    scheduled_emi: emi,

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
    "✓ Person saved",
    "success"
  );

  await loadData();
}

async function deletePerson(id) {

  if (!isOwner()) return;

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
    "✓ Person deleted",
    "success"
  );

  await loadData();
}

/* =========================================================
   PAYMENT ENTRY
   ========================================================= */

function openPayment(monthNo = null) {

  if (!isOwner()) {
    showAuth();
    return;
  }

  /*
     If editing, use selected month.
     Otherwise automatically select current month.
  */
  const selectedMonth =
    monthNo ||
    currentMonthNumber();

  if (
    selectedMonth < 1 ||
    selectedMonth >
      Number(loan.tenure_months)
  ) {

    toast(
      "Invalid payment month.",
      "error"
    );

    return;
  }

  const previous =
    calculateLoan(
      selectedMonth - 1
    );

  modal(`

    <h2>
      ${monthLabel(selectedMonth)}
    </h2>

    <p class="muted">
      Fixed EMI is automatically included.
      Enter only the extra principal amount
      paid by each person.
    </p>

    <div class="payment-info">

      <div>
        <small>Opening Principal</small>
        <b>
          ${money(previous.balance)}
        </b>
      </div>

      <div>
        <small>Minimum EMI</small>
        <b>
          ${money(minimumEMI())}
        </b>
      </div>

      <div>
        <small>Fixed EMI</small>
        <b>
          ${money(fixedEMITotal())}
        </b>
      </div>

    </div>

    <div id="paymentPeople">

      ${
        borrowers.length
          ? borrowers
              .map(
                person =>
                  paymentPersonRow(
                    person,
                    selectedMonth
                  )
              )
              .join("")
          : `
            <div class="empty">
              Add people first.
            </div>
          `
      }

    </div>

    ${
      borrowers.length
        ? `
          <button
            class="btn primary"
            onclick="savePayment(${selectedMonth})">
            ✓ Save Payment
          </button>
        `
        : ""
    }

  `);
}

function paymentPersonRow(
  person,
  monthNo
) {

  const old =
    getPayment(
      monthNo,
      person.id
    );

  return `

    <div class="pay">

      <div class="pt">

        <b>${esc(person.name)}</b>

        <span class="pill">
          EMI ${money(person.scheduled_emi)}
        </span>

      </div>

      <label>
        Extra Principal Paid
        <input
          id="extra_${person.id}"
          type="number"
          min="0"
          step="1"
          value="${
            old.extra_principal || ""
          }"
          placeholder="0">
      </label>

      <div class="calc">

        Fixed EMI:
        <b>
          ${money(person.scheduled_emi)}
        </b>

        <br>

        Extra Principal:
        <b>
          ${money(old.extra_principal || 0)}
        </b>

        <br>

        Total contribution:
        <b>
          ${money(
            (Number(person.scheduled_emi) || 0) +
            (Number(old.extra_principal) || 0)
          )}
        </b>

      </div>

    </div>
  `;
}

/* =========================================================
   SAVE PAYMENT
   ========================================================= */

async function savePayment(monthNo) {

  if (!isOwner()) return;

  const totalFixed =
    fixedEMITotal();

  if (!totalFixed) {

    toast(
      "Add fixed EMI for all people first.",
      "error"
    );

    return;
  }

  /*
     Save one row for every person.

     emi_paid is automatically the person's
     fixed EMI. User does not have to enter it.
  */
  for (const person of borrowers) {

    const extra =
      Number(
        $(`extra_${person.id}`)?.value
      ) || 0;

    const values = {

      loan_id: loan.id,

      borrower_id: person.id,

      month_no: monthNo,

      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      emi_paid:
        Number(person.scheduled_emi) || 0,

      extra_principal:
        extra

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
    `✓ ${monthLabel(monthNo)} payment saved`,
    "success"
  );

  await loadData();
}

/* =========================================================
   RESET LOAN
   ========================================================= */

async function resetLoan() {

  if (!isOwner()) {

    showAuth();

    return;
  }

  const first =
    confirm(
      "RESET DREAM HOME LOAN?\n\n" +
      "This will remove the loan, people and " +
      "all monthly payment records from the cloud."
    );

  if (!first) return;

  const second =
    prompt(
      'Type "RESET" to permanently continue.'
    );

  if (second !== "RESET") {

    toast(
      "Reset cancelled.",
      "error"
    );

    return;
  }

  /*
     Delete payment records first.
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
    "✓ Loan has been reset",
    "success"
  );

  await loadData();
}

/* =========================================================
   MODAL
   ========================================================= */

function modal(html) {

  const body = $("mb");

  if (!body) return;

  body.innerHTML = html;

  $("modal").classList.add("open");
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

  $("modal").onclick = event => {

    if (
      event.target ===
      $("modal")
    ) {
      closeModal();
    }

  };
}

/* =========================================================
   DATE FORMAT
   ========================================================= */

function formatDate(value) {

  if (!value) return "-";

  const d =
    new Date(`${value}T00:00:00`);

  return d.toLocaleDateString(
    "en-IN",
    {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }
  );
}

/* =========================================================
   AUTH STATE LISTENER
   ========================================================= */

if (db) {

  db.auth.onAuthStateChange(
    (event, session) => {

      user =
        session?.user || null;

      updateAccountIcon();

      /*
         Delay prevents Supabase auth
         event recursion issues.
      */
      setTimeout(
        () => loadData(),
        0
      );
    }
  );

}

/* =========================================================
   SERVICE WORKER
   ========================================================= */

if ("serviceWorker" in navigator) {

  navigator.serviceWorker
    .register("./sw.js")
    .catch(error =>
      console.log(
        "Service worker:",
        error
      )
    );

}

/* =========================================================
   INITIAL LOAD
   ========================================================= */

updateAccountIcon();

if (db) {

  loadData();

} else {

  syncStatus("bad");

  renderDashboard();

}

navigate("dashboard");
