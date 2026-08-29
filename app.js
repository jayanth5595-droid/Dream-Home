/* =========================================================
   DREAM HOME
   Single Overall Loan Model
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

const $ = id => document.getElementById(id);


/* =========================================================
   HELPERS
   ========================================================= */

const M = n =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Math.round(Number(n) || 0));

const N = n =>
  Math.round(Number(n) || 0);

const esc = x =>
  String(x ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");


function toast(title, message = "", type = "success") {
  let box = $("toast");

  if (!box) return;

  box.innerHTML = `
    <div class="toast-inner ${type}">
      <div class="toast-icon">
        ${
          type === "error"
            ? "!"
            : type === "warning"
            ? "!"
            : "✓"
        }
      </div>

      <div>
        <strong>${esc(title)}</strong>
        ${
          message
            ? `<div>${esc(message)}</div>`
            : ""
        }
      </div>
    </div>
  `;

  box.style.display = "block";
  box.classList.remove("show");

  setTimeout(() => {
    box.classList.add("show");
  }, 10);

  clearTimeout(window.toastTimer);

  window.toastTimer = setTimeout(() => {
    box.classList.remove("show");

    setTimeout(() => {
      box.style.display = "none";
    }, 250);
  }, 2800);
}


function sync(state) {
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
   DATE FUNCTIONS
   ========================================================= */

function monthDate(monthNo) {
  if (!loan || !loan.start_date) {
    return new Date();
  }

  const d = new Date(
    loan.start_date + "T00:00:00"
  );

  d.setMonth(
    d.getMonth() + Number(monthNo) - 1
  );

  return d;
}


function monthName(monthNo) {
  const d = monthDate(monthNo);

  return d.toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric"
  });
}


function monthFull(monthNo) {
  const d = monthDate(monthNo);

  return d.toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric"
  });
}


/* =========================================================
   LOAN CALCULATION
   ========================================================= */

function monthlyRate() {
  if (!loan) return 0;

  return (
    Number(loan.annual_rate || 0) /
    100 /
    12
  );
}


/*
  Bank's calculated minimum EMI for the entire loan.
*/

function minimumEMI() {
  if (!loan) return 0;

  const principal =
    Number(loan.total_amount) || 0;

  const months =
    Number(loan.tenure_months) || 0;

  const r = monthlyRate();

  if (!principal || !months) {
    return 0;
  }

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
  Total fixed EMI of all persons.
*/

function fixedEMITotal() {
  return bs.reduce(
    (sum, b) =>
      sum +
      Number(b.scheduled_emi || 0),
    0
  );
}


/*
  Payment record for person/month.
*/

function getPayment(monthNo, borrowerId) {
  return (
    ps.find(
      p =>
        Number(p.month_no) ===
          Number(monthNo) &&
        p.borrower_id === borrowerId
    ) || {
      emi_paid: 0,
      extra_principal: 0
    }
  );
}


/*
  IMPORTANT:
  The old app calculated separate interest for
  each person's principal share.

  The new app DOES NOT do that.

  There is ONE overall loan principal.
*/

function calculateMonth(monthNo) {
  let openingPrincipal =
    Number(loan?.total_amount) || 0;

  let totalPrincipalPaid = 0;
  let totalInterestPaid = 0;
  let totalInterestDue = 0;
  let totalExtra = 0;
  let totalFixedPaid = 0;
  let unpaidInterest = 0;

  /*
    Calculate every previous month first.
  */

  for (
    let m = 1;
    m <= monthNo;
    m++
  ) {
    const interest =
      openingPrincipal *
      monthlyRate();

    const fixedTotal =
      fixedEMITotal();

    let fixedPaid =
      fixedTotal;

    /*
      During interest-only period:
      fixed EMI does not reduce principal.
    */

    const interestOnly =
      m <=
      Number(
        loan?.interest_only_months || 0
      );

    let principalFromFixed = 0;
    let surplus = 0;

    if (interestOnly) {
      totalInterestDue += interest;

      totalInterestPaid += Math.min(
        fixedPaid,
        interest
      );

      unpaidInterest += Math.max(
        0,
        interest - fixedPaid
      );

      /*
        Any personal EXTRA payment is still
        100% principal.
      */
    } else {
      /*
        Normal minimum EMI portion.
      */

      const minEMI =
        minimumEMI();

      const normalEMIPaid =
        Math.min(
          fixedPaid,
          minEMI
        );

      totalInterestDue += interest;

      totalInterestPaid += Math.min(
        normalEMIPaid,
        interest
      );

      unpaidInterest += Math.max(
        0,
        interest - normalEMIPaid
      );

      principalFromFixed =
        Math.max(
          0,
          normalEMIPaid - interest
        );

      /*
        If all fixed EMIs are greater than
        the minimum required EMI, the
        difference becomes extra principal.
      */

      surplus =
        Math.max(
          0,
          fixedPaid - minEMI
        );

      /*
        If fixed EMI itself is less than
        minimum EMI, don't create surplus.
      */

      principalFromFixed = Math.min(
        principalFromFixed,
        openingPrincipal
      );

      openingPrincipal -=
        principalFromFixed;

      totalPrincipalPaid +=
        principalFromFixed;
    }

    /*
      Personal extra payments.
      These ALWAYS reduce overall principal.
    */

    let monthExtra = 0;

    for (const b of bs) {
      const p =
        getPayment(m, b.id);

      monthExtra += Math.max(
        0,
        Number(p.extra_principal) || 0
      );
    }

    /*
      The fixed-EMI surplus is also principal.
    */

    const totalPrincipalExtra =
      surplus + monthExtra;

    const extraApplied =
      Math.min(
        totalPrincipalExtra,
        openingPrincipal
      );

    openingPrincipal -=
      extraApplied;

    totalPrincipalPaid +=
      extraApplied;

    totalExtra +=
      totalPrincipalExtra;
  }

  return {
    remainingPrincipal:
      Math.max(0, openingPrincipal),

    principalPaid:
      Math.min(
        Number(loan?.total_amount) || 0,
        totalPrincipalPaid
      ),

    interestPaid:
      totalInterestPaid,

    interestDue:
      totalInterestDue,

    totalExtra,

    fixedPaid:
      totalFixedPaid,

    unpaidInterest
  };
}


/* =========================================================
   MONTH-SPECIFIC CALCULATION
   ========================================================= */

function monthCalculation(monthNo) {
  /*
    Get opening balance immediately before this month.
  */

  if (monthNo <= 1) {
    return {
      openingPrincipal:
        Number(loan?.total_amount) || 0,
      interest:
        (Number(loan?.total_amount) || 0) *
        monthlyRate()
    };
  }

  const previous =
    calculateMonth(monthNo - 1);

  return {
    openingPrincipal:
      previous.remainingPrincipal,

    interest:
      previous.remainingPrincipal *
      monthlyRate()
  };
}


/* =========================================================
   INDIVIDUAL CONTRIBUTION
   ========================================================= */

function borrowerStats(borrower) {
  let emiPaid = 0;
  let personalExtra = 0;

  for (const p of ps) {
    if (p.borrower_id !== borrower.id) {
      continue;
    }

    emiPaid +=
      Number(p.emi_paid || 0);

    personalExtra +=
      Number(p.extra_principal || 0);
  }

  /*
    Calculate the equal share of fixed-EMI
    surplus attributed to this person.
  */

  let equalSurplus = 0;

  const peopleCount = bs.length;

  if (peopleCount) {
    for (
      let m = 1;
      m <= Number(loan?.tenure_months || 0);
      m++
    ) {
      const isInterestOnly =
        m <=
        Number(
          loan?.interest_only_months || 0
        );

      if (isInterestOnly) {
        continue;
      }

      const surplus =
        Math.max(
          0,
          fixedEMITotal() -
            minimumEMI()
        );

      equalSurplus +=
        surplus / peopleCount;
    }
  }

  /*
    For contribution tracking:
    fixed EMI itself is paid by the person.
    Personal extra is theirs.
    Equal surplus is shared equally.
  */

  const totalContribution =
    emiPaid +
    personalExtra;

  const principalContribution =
    personalExtra +
    equalSurplus;

  const totalLoan =
    Number(loan?.total_amount) || 0;

  return {
    emiPaid,
    personalExtra,
    equalSurplus,
    totalContribution,
    principalContribution,

    contributionPercent:
      totalLoan
        ? (principalContribution /
            totalLoan) *
          100
        : 0
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
      titles[id] ||
      "Dream Home";
  }

  if (id === "dashboard")
    dashboard();

  if (id === "payments")
    payments();

  if (id === "people")
    people();

  if (id === "reports")
    reports();

  if (id === "more")
    more();
}


document
  .querySelectorAll("nav button")
  .forEach(btn => {
    btn.onclick = () =>
      nav(btn.dataset.s);
  });


/* =========================================================
   MODAL
   ========================================================= */

function modal(html) {
  $("mb").innerHTML = html;

  $("modal").classList.add(
    "open"
  );
}


function close() {
  $("modal").classList.remove(
    "open"
  );
}


if ($("x")) {
  $("x").onclick = close;
}


if ($("modal")) {
  $("modal").onclick = e => {
    if (
      e.target === $("modal")
    ) {
      close();
    }
  };
}


/* =========================================================
   OWNER BUTTON
   ========================================================= */

if ($("account")) {
  $("account").onclick = () => {
    accountPopup();
  };
}


function accountPopup() {
  if (!user) {
    auth();
    return;
  }

  modal(`
    <div class="account-popup">

      <div class="account-avatar">
        👤
      </div>

      <h2>Owner Account</h2>

      <p class="muted">
        ${esc(user.email)}
      </p>

      <div class="pill">
        OWNER · EDIT ACCESS
      </div>

      <br>

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
  if (!db) {
    toast(
      "Connection problem",
      "Supabase is not configured.",
      "error"
    );
    return;
  }

  modal(`
    <div class="account-popup">

      <div class="account-avatar">
        🔐
      </div>

      <h2>Owner Sign In</h2>

      <p class="muted">
        Only the owner can edit Dream Home.
      </p>

      <label>
        Email

        <input
          id="ae"
          type="email"
          autocomplete="email"
          placeholder="Enter your email">
      </label>

      <label>
        Password

        <input
          id="ap"
          type="password"
          autocomplete="current-password"
          placeholder="Enter your password">
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
  if (!db) return;

  const email =
    $("ae").value.trim();

  const password =
    $("ap").value;

  if (!email || !password) {
    toast(
      "Missing details",
      "Enter your email and password.",
      "warning"
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
      "Sign in failed",
      q.error.message,
      "error"
    );
    return;
  }

  user =
    q.data?.user || null;

  close();

  await load();

  toast(
    "Welcome back!",
    "Owner editing is enabled."
  );
}


async function signup() {
  if (!db) return;

  const email =
    $("ae").value.trim();

  const password =
    $("ap").value;

  if (!email || !password) {
    toast(
      "Missing details",
      "Enter your email and password.",
      "warning"
    );
    return;
  }

  if (password.length < 6) {
    toast(
      "Password too short",
      "Use at least 6 characters.",
      "warning"
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
      "Account creation failed",
      q.error.message,
      "error"
    );
    return;
  }

  user =
    q.data?.user || null;

  close();

  if (!q.data?.session) {
    toast(
      "Account created",
      "Check your email to confirm the account."
    );
  } else {
    toast(
      "Owner account created",
      "You can now manage Dream Home."
    );
  }

  await load();
}


async function out() {
  if (!db) return;

  await db.auth.signOut();

  user = null;

  close();

  await load();

  toast(
    "Signed out",
    "Dream Home is now in public view mode."
  );
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

  sync("");

  try {
    const uq =
      await db.auth.getUser();

    user =
      uq.data?.user || null;

    const l =
      await db
        .from("loans")
        .select("*")
        .order("created_at", {
          ascending: true
        })
        .limit(1)
        .maybeSingle();

    if (l.error) {
      console.error(l.error);

      toast(
        "Cloud error",
        l.error.message,
        "error"
      );

      sync("bad");
      return;
    }

    loan = l.data || null;

    bs = [];
    ps = [];

    if (loan) {
      const [b, p] =
        await Promise.all([
          db
            .from("borrowers")
            .select("*")
            .eq(
              "loan_id",
              loan.id
            )
            .order("sort_order"),

          db
            .from("monthly_payments")
            .select("*")
            .eq(
              "loan_id",
              loan.id
            )
            .order("month_no")
        ]);

      if (b.error) {
        toast(
          "Borrower error",
          b.error.message,
          "error"
        );

        sync("bad");
        return;
      }

      if (p.error) {
        toast(
          "Payment error",
          p.error.message,
          "error"
        );

        sync("bad");
        return;
      }

      bs =
        b.data || [];

      ps =
        p.data || [];
    }

    sync("ok");

    dashboard();

  } catch (err) {
    console.error(err);

    toast(
      "Connection error",
      err.message ||
        "Unable to connect.",
      "error"
    );

    sync("bad");
  }
}


/* =========================================================
   DASHBOARD
   ========================================================= */

function dashboard() {
  if (!loan) {
    $("dashboard").innerHTML = `
      <div class="hero">

        <small>DREAM HOME</small>

        <strong>
          Your Home Loan Tracker
        </strong>

        <div>
          ${
            user
              ? "Create your loan to get started."
              : "Public view mode"
          }
        </div>

      </div>

      <div class="card">

        <h2>
          ${user
            ? "Create your loan"
            : "Welcome to Dream Home"}
        </h2>

        <p class="muted">
          ${
            user
              ? "Set the overall loan amount, interest rate, tenure and interest-only period."
              : "Tap the person icon to sign in as the owner."
          }
        </p>

        ${
          user
            ? `
              <button
                class="btn primary"
                onclick="loanEdit()">
                🏠 Create Loan
              </button>
            `
            : ""
        }

      </div>
    `;

    return;
  }


  const result =
    calculateMonth(
      loan.tenure_months
    );

  const original =
    Number(loan.total_amount) || 0;

  const remaining =
    result.remainingPrincipal;

  const principalPaid =
    Math.max(
      0,
      original - remaining
    );

  const totalInterestPaid =
    result.interestPaid;

  const totalCashPaid =
    ps.reduce(
      (sum, p) =>
        sum +
        Number(p.emi_paid || 0) +
        Number(
          p.extra_principal || 0
        ),
      0
    );

  const percentPaid =
    original
      ? (principalPaid /
          original) *
        100
      : 0;


  $("dashboard").innerHTML = `

    <div class="hero">

      <small>
        REMAINING PRINCIPAL
      </small>

      <strong>
        ${M(remaining)}
      </strong>

      <div>
        Original ${M(original)}
        · ${loan.annual_rate}%
        · ${loan.tenure_months} months
      </div>

    </div>


    <div class="metrics">

      <div class="metric">
        <small>
          Principal paid
        </small>

        <strong>
          ${M(principalPaid)}
        </strong>
      </div>


      <div class="metric">
        <small>
          Interest paid
        </small>

        <strong>
          ${M(totalInterestPaid)}
        </strong>
      </div>


      <div class="metric">
        <small>
          Total paid
        </small>

        <strong>
          ${M(totalCashPaid)}
        </strong>
      </div>


      <div class="metric">
        <small>
          Loan paid
        </small>

        <strong>
          ${percentPaid.toFixed(2)}%
        </strong>
      </div>

    </div>


    <div class="card">

      <div class="pt">

        <h2>
          Loan Summary
        </h2>

        <span class="pill">
          ${edit()
            ? "OWNER"
            : "VIEW ONLY"}
        </span>

      </div>


      <div class="row">
        <span>Minimum EMI</span>
        <b>${M(minimumEMI())}</b>
      </div>


      <div class="row">
        <span>Fixed EMIs</span>
        <b>${M(fixedEMITotal())}</b>
      </div>


      <div class="row">
        <span>Extra EMI surplus</span>
        <b>
          ${M(
            Math.max(
              0,
              fixedEMITotal() -
                minimumEMI()
            )
          )}
        </b>
      </div>


      <div class="row">
        <span>Unpaid interest</span>
        <b>
          ${M(result.unpaidInterest)}
        </b>
      </div>

    </div>


    <div class="card">

      <div class="pt">
        <h2>
          Contributions
        </h2>
      </div>


      ${
        bs.length
          ? bs
              .map(b => {
                const s =
                  borrowerStats(b);

                return `
                  <div class="person">

                    <div class="pt">

                      <b>
                        ${esc(b.name)}
                      </b>

                      <span class="pill">
                        ${s.contributionPercent.toFixed(2)}%
                      </span>

                    </div>


                    <div class="row">
                      <span>
                        Fixed EMI paid
                      </span>

                      <b>
                        ${M(s.emiPaid)}
                      </b>
                    </div>


                    <div class="row">
                      <span>
                        Personal extra
                      </span>

                      <b>
                        ${M(s.personalExtra)}
                      </b>
                    </div>


                    <div class="row">
                      <span>
                        Equal EMI surplus
                      </span>

                      <b>
                        ${M(s.equalSurplus)}
                      </b>
                    </div>


                    <div class="row">
                      <span>
                        Total contribution
                      </span>

                      <b>
                        ${M(
                          s.totalContribution
                        )}
                      </b>
                    </div>


                    <div class="muted">
                      Principal contribution:
                      ${M(
                        s.principalContribution
                      )}
                    </div>

                  </div>
                `;
              })
              .join("")
          : `
            <div class="empty">
              Add borrowers from the People tab.
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
  $("people").innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>People</h2>

          <div class="muted">
            Fixed monthly EMI
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


      ${
        bs.length
          ? bs
              .map(b => {
                const s =
                  borrowerStats(b);

                return `
                  <div class="row">

                    <div>

                      <b>
                        ${esc(b.name)}
                      </b>

                      <div class="muted">
                        Fixed EMI:
                        ${M(
                          b.scheduled_emi
                        )}
                      </div>

                    </div>


                    ${
                      edit()
                        ? `
                          <button
                            class="btn soft"
                            onclick="person('${b.id}')">
                            Edit
                          </button>
                        `
                        : ""
                    }

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


    <div class="card">

      <h2>
        EMI Overview
      </h2>

      <div class="row">
        <span>
          Bank minimum EMI
        </span>

        <b>
          ${M(minimumEMI())}
        </b>
      </div>


      <div class="row">
        <span>
          Your fixed EMIs
        </span>

        <b>
          ${M(fixedEMITotal())}
        </b>
      </div>


      <div class="row">
        <span>
          Monthly surplus
        </span>

        <b>
          ${M(
            Math.max(
              0,
              fixedEMITotal() -
                minimumEMI()
            )
          )}
        </b>
      </div>

    </div>
  `;
}


/* =========================================================
   ADD / EDIT PERSON
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
      ${id ? "Edit Person" : "Add Person"}
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
        min="0"
        value="${b.scheduled_emi || ""}"
        placeholder="Example: 15000">
    </label>


    <p class="muted">
      This EMI will automatically be entered
      every month. You only enter the extra
      payment when someone pays more.
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


async function savePerson(id) {
  if (!edit()) {
    auth();
    return;
  }

  const name =
    $("bn").value.trim();

  const emi =
    Number($("be").value) || 0;

  if (!name) {
    toast(
      "Name required",
      "Enter the person's name.",
      "warning"
    );
    return;
  }

  if (emi < 0) {
    toast(
      "Invalid EMI",
      "Enter a valid EMI amount.",
      "warning"
    );
    return;
  }

  const v = {
    loan_id: loan.id,

    name,

    /*
      Kept for compatibility with your
      existing Supabase table.
      It is NO LONGER used for calculation.
    */
    share_amount: 0,

    scheduled_emi: emi,

    sort_order: id
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
      "Could not save",
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Saved",
    `${name}'s fixed EMI is ${M(emi)}.`
  );
}


async function delPerson(id) {
  if (!edit()) {
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

  const q =
    await db
      .from("borrowers")
      .delete()
      .eq("id", id);

  if (q.error) {
    toast(
      "Delete failed",
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Person deleted"
  );
}


/* =========================================================
   PAYMENTS
   ========================================================= */

function payments() {
  if (!loan) {
    $("payments").innerHTML = `
      <div class="card">
        <h2>Payments</h2>
        <div class="empty">
          Create the loan first.
        </div>
      </div>
    `;
    return;
  }

  const months = [
    ...new Set(
      ps.map(
        p => Number(p.month_no)
      )
    )
  ].sort(
    (a, b) => b - a
  );

  $("payments").innerHTML = `

    <div class="card">

      <div class="pt">

        <div>
          <h2>Payments</h2>

          <div class="muted">
            ${
              months.length
            } month(s) recorded
          </div>
        </div>

        ${
          edit()
            ? `
              <button
                class="btn primary"
                onclick="payment()">
                ＋ Pay
              </button>
            `
            : ""
        }

      </div>


      ${
        months.length
          ? months
              .map(m => {

                const records =
                  ps.filter(
                    p =>
                      Number(
                        p.month_no
                      ) === m
                  );

                const extra =
                  records.reduce(
                    (a, p) =>
                      a +
                      Number(
                        p.extra_principal ||
                          0
                      ),
                    0
                  );

                const paid =
                  fixedEMITotal();

                return `
                  <div class="row payment-row">

                    <div>

                      <b>
                        ${monthFull(m)}
                      </b>

                      <div class="muted">
                        Fixed EMI:
                        ${M(paid)}
                        · Extra:
                        ${M(extra)}
                      </div>

                    </div>


                    ${
                      edit()
                        ? `
                          <button
                            class="btn soft"
                            onclick="payment(${m})">
                            ✏️ Edit
                          </button>
                        `
                        : ""
                    }

                  </div>
                `;
              })
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
   PAYMENT ENTRY / EDIT
   ========================================================= */

function payment(editMonth = null) {
  if (!edit()) {
    auth();
    return;
  }

  if (!bs.length) {
    toast(
      "Add people first",
      "Add the fixed EMI for each person.",
      "warning"
    );
    return;
  }

  let m = editMonth;

  if (!m) {
    const next =
      ps.length
        ? Math.max(
            ...ps.map(
              p =>
                Number(
                  p.month_no
                )
            )
          ) + 1
        : 1;

    m = Number(
      prompt(
        "Enter month number\n\n" +
          "1 = " +
          monthName(1) +
          "\n" +
          "2 = " +
          monthName(2) +
          "\n" +
          "3 = " +
          monthName(3),
        next
      )
    );
  }

  if (
    !m ||
    m < 1 ||
    m >
      Number(
        loan.tenure_months
      )
  ) {
    return;
  }

  const mc =
    monthCalculation(m);

  const interestOnly =
    m <=
    Number(
      loan.interest_only_months || 0
    );

  const minimum =
    minimumEMI();

  const fixed =
    fixedEMITotal();

  const surplus =
    Math.max(
      0,
      fixed - minimum
    );

  modal(`

    <div class="payment-header">

      <small>
        MONTHLY PAYMENT
      </small>

      <h2>
        ${monthFull(m)}
      </h2>

      <div class="muted">
        Month ${m} of
        ${loan.tenure_months}
      </div>

    </div>


    <div class="card mini-card">

      <div class="row">
        <span>Opening principal</span>
        <b>
          ${M(mc.openingPrincipal)}
        </b>
      </div>

      <div class="row">
        <span>Interest this month</span>
        <b>
          ${M(mc.interest)}
        </b>
      </div>

      <div class="row">
        <span>Bank minimum EMI</span>
        <b>
          ${M(minimum)}
        </b>
      </div>

      <div class="row">
        <span>Fixed EMIs</span>
        <b>
          ${M(fixed)}
        </b>
      </div>

      ${
        surplus > 0
          ? `
            <div class="row">
              <span>
                EMI surplus → principal
              </span>

              <b>
                ${M(surplus)}
              </b>
            </div>
          `
          : ""
      }

      ${
        interestOnly
          ? `
            <p class="muted">
              ℹ️ Interest-only period:
              fixed EMI will not reduce
              principal. Personal extra
              payments still reduce principal.
            </p>
          `
          : ""
      }

    </div>


    <p class="muted">
      Fixed EMI is automatic.
      Enter only the additional amount
      paid personally.
    </p>


    <div id="paymentPeople"></div>


    <button
      class="btn primary"
      onclick="savePayment(${m})">

      ✓ ${
        editMonth
          ? "Update Payment"
          : "Save Payment"
      }

    </button>


    ${
      editMonth
        ? `
          <button
            class="btn danger"
            onclick="deleteMonth(${m})">
            🗑️ Delete This Month
          </button>
        `
        : ""
    }

  `);


  $("paymentPeople").innerHTML =
    bs
      .map(b => {

        const existing =
          getPayment(
            m,
            b.id
          );

        return `
          <div class="pay">

            <div class="pt">

              <b>
                ${esc(b.name)}
              </b>

              <span class="pill">
                EMI ${M(
                  b.scheduled_emi
                )}
              </span>

            </div>


            <label>
              Extra amount paid

              <input
                id="extra_${b.id}"
                type="number"
                min="0"
                step="1"
                value="${
                  existing.extra_principal ||
                  ""
                }"
                placeholder="0">
            </label>


            <div class="calc">

              Fixed EMI:
              <b>
                ${M(
                  b.scheduled_emi
                )}
              </b>

              <br>

              Personal extra:
              <b>
                ${M(
                  existing.extra_principal ||
                    0
                )}
              </b>

              <br>

              Total payment:
              <b>
                ${M(
                  Number(
                    b.scheduled_emi ||
                      0
                  ) +
                    Number(
                      existing.extra_principal ||
                        0
                    )
                )}
              </b>

            </div>

          </div>
        `;
      })
      .join("");
}


/* =========================================================
   SAVE PAYMENT
   ========================================================= */

async function savePayment(m) {
  if (!edit()) {
    auth();
    return;
  }

  for (const b of bs) {

    const extra =
      Math.max(
        0,
        Number(
          $(
            "extra_" +
              b.id
          ).value
        ) || 0
      );

    const v = {
      loan_id: loan.id,

      borrower_id: b.id,

      month_no: m,

      payment_date:
        monthDate(m)
          .toISOString()
          .slice(0, 10),

      /*
        Fixed EMI is automatic.
      */

      emi_paid:
        Number(
          b.scheduled_emi
        ) || 0,

      /*
        Extra is 100% principal.
      */

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
      console.error(q.error);

      toast(
        "Payment failed",
        q.error.message,
        "error"
      );

      return;
    }
  }

  close();

  await load();

  toast(
    "Payment saved",
    `${monthFull(m)} has been updated.`
  );
}


/* =========================================================
   DELETE ONE MONTH
   ========================================================= */

async function deleteMonth(m) {
  if (!edit()) {
    auth();
    return;
  }

  if (
    !confirm(
      `Delete all payment entries for ${monthFull(
        m
      )}?`
    )
  ) {
    return;
  }

  const q =
    await db
      .from("monthly_payments")
      .delete()
      .eq("loan_id", loan.id)
      .eq("month_no", m);

  if (q.error) {
    toast(
      "Delete failed",
      q.error.message,
      "error"
    );
    return;
  }

  close();

  await load();

  toast(
    "Payment deleted",
    monthFull(m)
  );
}


/* =========================================================
   REPORTS
   ========================================================= */

function reports() {
  if (!loan) {
    $("reports").innerHTML = `
      <div class="card">
        <h2>Reports</h2>
        <div class="empty">
          Create a loan first.
        </div>
      </div>
    `;

    return;
  }

  const r =
    calculateMonth(
      loan.tenure_months
    );

  const original =
    Number(loan.total_amount) || 0;

  const principalPaid =
    original -
    r.remainingPrincipal;

  const totalPaid =
    ps.reduce(
      (a, p) =>
        a +
        Number(
          p.emi_paid || 0
        ) +
        Number(
          p.extra_principal || 0
        ),
      0
    );

  $("reports").innerHTML = `

    <div class="card">

      <h2>
        Loan Report
      </h2>


      <div class="row">
        <span>
          Original loan
        </span>

        <b>
          ${M(original)}
        </b>
      </div>


      <div class="row">
        <span>
          Remaining principal
        </span>

        <b>
          ${M(
            r.remainingPrincipal
          )}
        </b>
      </div>


      <div class="row">
        <span>
          Principal paid
        </span>

        <b>
          ${M(principalPaid)}
        </b>
      </div>


      <div class="row">
        <span>
          Interest paid
        </span>

        <b>
          ${M(
            r.interestPaid
          )}
        </b>
      </div>


      <div class="row">
        <span>
          Total cash paid
        </span>

        <b>
          ${M(totalPaid)}
        </b>
      </div>


      <div class="row">
        <span>
          Loan paid
        </span>

        <b>
          ${
            original
              ? (
                  principalPaid /
                  original *
                  100
                ).toFixed(2)
              : "0.00"
          }%
        </b>
      </div>


      <div class="row">
        <span>
          Minimum EMI
        </span>

        <b>
          ${M(minimumEMI())}
        </b>
      </div>


      <div class="row">
        <span>
          Fixed EMI total
        </span>

        <b>
          ${M(fixedEMITotal())}
        </b>
      </div>


      <div class="row">
        <span>
          Unpaid interest
        </span>

        <b>
          ${M(
            r.unpaidInterest
          )}
        </b>
      </div>

    </div>


    <div class="card">

      <h2>
        Person Contributions
      </h2>


      ${
        bs
          .map(b => {
            const s =
              borrowerStats(b);

            return `
              <div class="person">

                <div class="pt">

                  <b>
                    ${esc(b.name)}
                  </b>

                  <span class="pill">
                    ${s.contributionPercent.toFixed(
                      2
                    )}%
                  </span>

                </div>


                <div class="row">
                  <span>
                    Fixed EMI paid
                  </span>

                  <b>
                    ${M(s.emiPaid)}
                  </b>
                </div>


                <div class="row">
                  <span>
                    Personal extra
                  </span>

                  <b>
                    ${M(s.personalExtra)}
                  </b>
                </div>


                <div class="row">
                  <span>
                    Principal contribution
                  </span>

                  <b>
                    ${M(
                      s.principalContribution
                    )}
                  </b>
                </div>


                <div class="bar">
                  <i
                    style="width:${Math.min(
                      100,
                      Math.max(
                        0,
                        s.contributionPercent
                      )
                    )}%">
                  </i>
                </div>

              </div>
            `;
          })
          .join("") ||
        `
          <div class="empty">
            No people added.
          </div>
        `
      }

    </div>
  `;
}


/* =========================================================
   LOAN SETTINGS
   ========================================================= */

function loanEdit() {
  if (!user) {
    auth();
    return;
  }

  const creating =
    !loan;

  const c =
    loan || {
      name: "Dream Home Loan",
      total_amount: 4500000,
      annual_rate: 8.9,
      tenure_months: 240,
      start_date:
        new Date()
          .toISOString()
          .slice(0, 10),
      interest_only_months: 6
    };

  modal(`

    <h2>
      ${
        creating
          ? "Create Loan"
          : "Loan Settings"
      }
    </h2>


    <label>
      Loan name

      <input
        id="ln"
        value="${esc(c.name)}">
    </label>


    <label>
      Overall loan amount

      <input
        id="la"
        type="number"
        min="0"
        value="${c.total_amount}">
    </label>


    <label>
      Annual interest %

      <input
        id="lr"
        type="number"
        min="0"
        step="0.01"
        value="${c.annual_rate}">
    </label>


    <label>
      Tenure in months

      <input
        id="lt"
        type="number"
        min="1"
        value="${c.tenure_months}">
    </label>


    <label>
      Loan start date

      <input
        id="ls"
        type="date"
        value="${c.start_date || ""}">
    </label>


    <label>
      Interest-only period

      <input
        id="li"
        type="number"
        min="0"
        value="${
          c.interest_only_months || 0
        }">

    </label>


    <div class="card mini-card">

      <div class="row">
        <span>
          Calculated minimum EMI
        </span>

        <b id="previewEMI">
          —
        </b>
      </div>

    </div>


    <p class="muted">
      There is one overall loan principal.
      Individual principal shares are not used.
      Personal extra payments always reduce
      the overall principal.
    </p>


    <button
      class="btn primary"
      onclick="saveLoan()">

      ${
        creating
          ? "Create Loan"
          : "Save Changes"
      }

    </button>

  `);

  updateLoanPreview();

  ["la", "lr", "lt"].forEach(
    id => {
      if ($(id)) {
        $(id).oninput =
          updateLoanPreview;
      }
    }
  );
}


function updateLoanPreview() {
  const amount =
    Number(
      $("la")?.value
    ) || 0;

  const rate =
    Number(
      $("lr")?.value
    ) || 0;

  const months =
    Number(
      $("lt")?.value
    ) || 0;

  if (!amount || !months) {
    if ($("previewEMI"))
      $("previewEMI").textContent =
        "—";

    return;
  }

  const r =
    rate / 100 / 12;

  let value;

  if (!r) {
    value =
      amount / months;
  } else {
    value =
      amount *
      r *
      Math.pow(
        1 + r,
        months
      ) /
      (
        Math.pow(
          1 + r,
          months
        ) - 1
      );
  }

  if ($("previewEMI")) {
    $("previewEMI").textContent =
      M(value);
  }
}


/* =========================================================
   SAVE / CREATE LOAN
   ========================================================= */

async function saveLoan() {
  if (!db || !user) {
    auth();
    return;
  }

  const total =
    Number(
      $("la").value
    ) || 0;

  const annualRate =
    Number(
      $("lr").value
    ) || 0;

  const tenure =
    Number(
      $("lt").value
    ) || 0;

  const interestOnly =
    Number(
      $("li").value
    ) || 0;

  const startDate =
    $("ls").value;

  if (total <= 0) {
    toast(
      "Invalid loan amount",
      "Enter the overall loan amount.",
      "warning"
    );
    return;
  }

  if (annualRate < 0) {
    toast(
      "Invalid interest rate",
      "Enter a valid interest rate.",
      "warning"
    );
    return;
  }

  if (tenure <= 0) {
    toast(
      "Invalid tenure",
      "Enter the tenure in months.",
      "warning"
    );
    return;
  }

  if (
    interestOnly >
    tenure
  ) {
    toast(
      "Invalid interest-only period",
      "It cannot exceed the loan tenure.",
      "warning"
    );
    return;
  }

  const v = {
    name:
      $("ln").value.trim() ||
      "Dream Home Loan",

    total_amount:
      total,

    annual_rate:
      annualRate,

    tenure_months:
      tenure,

    start_date:
      startDate || null,

    interest_only_months:
      interestOnly,

    /*
      Kept for compatibility with
      existing database structure.
    */
    emi_mode:
      "auto",

    manual_emi:
      0,

    updated_at:
      new Date().toISOString()
  };

  let q;

  if (!loan) {

    q =
      await db
        .from("loans")
        .insert({
          ...v,
          created_by:
            user.id
        })
        .select()
        .single();

  } else {

    q =
      await db
        .from("loans")
        .update(v)
        .eq(
          "id",
          loan.id
        )
        .eq(
          "created_by",
          user.id
        )
        .select()
        .single();

  }

  if (q.error) {
    console.error(q.error);

    toast(
      "Loan save failed",
      q.error.message,
      "error"
    );

    return;
  }

  loan = q.data;

  close();

  await load();

  toast(
    !loan
      ? "Loan created"
      : "Loan updated",
    `${M(total)} at ${annualRate}%`
  );
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
      "Type RESET to permanently delete the loan, people and payment history."
    );

  if (
    answer !== "RESET"
  ) {
    toast(
      "Reset cancelled"
    );
    return;
  }

  /*
    Delete payments first.
  */

  let q =
    await db
      .from("monthly_payments")
      .delete()
      .eq(
        "loan_id",
        loan.id
      );

  if (q.error) {
    toast(
      "Reset failed",
      q.error.message,
      "error"
    );
    return;
  }


  /*
    Delete borrowers.
  */

  q =
    await db
      .from("borrowers")
      .delete()
      .eq(
        "loan_id",
        loan.id
      );

  if (q.error) {
    toast(
      "Reset failed",
      q.error.message,
      "error"
    );
    return;
  }


  /*
    Delete loan.
  */

  q =
    await db
      .from("loans")
      .delete()
      .eq(
        "id",
        loan.id
      )
      .eq(
        "created_by",
        user.id
      );

  if (q.error) {
    toast(
      "Reset failed",
      q.error.message,
      "error"
    );
    return;
  }

  loan = null;
  bs = [];
  ps = [];

  close();

  await load();

  toast(
    "Loan reset",
    "All loan records have been removed."
  );
}


/* =========================================================
   MORE
   ========================================================= */

function more() {
  $("more").innerHTML = `

    <div class="card">

      <h2>
        Account
      </h2>

      <div class="muted">

        ${
          user
            ? `
              Owner account active.
              Tap the 👤 icon to sign out.
            `
            : `
              Public view mode.
              Tap the 👤 icon to sign in.
            `
        }

      </div>

    </div>


    ${
      edit()
        ? `
          <div class="card">

            <h2>
              Loan Management
            </h2>


            <div class="row">

              <b>
                Loan Settings
              </b>

              <button
                class="btn soft"
                onclick="loanEdit()">
                Open
              </button>

            </div>


            <div class="row">

              <b>
                Reset Loan
              </b>

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


    <div class="card">

      <h2>
        Cloud Status
      </h2>

      <div class="row">

        <span>
          Supabase
        </span>

        <span class="pill">
          ${
            db
              ? "CONNECTED"
              : "NOT CONNECTED"
          }
        </span>

      </div>

    </div>

  `;
}


/* =========================================================
   INITIALIZE
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

  load();

} else {

  sync("bad");

  dashboard();
}


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
   START
   ========================================================= */

nav("dashboard");  Loan calculation.

  Each borrower's share is treated independently.

  During interest-only months:
  - EMI does NOT reduce principal.
  - Extra principal still reduces principal.

  After interest-only period:
  - Actual EMI first covers interest.
  - Amount above interest reduces principal.
  - Extra principal additionally reduces principal.
*/

function calc(b, n) {
  let bal = +b.share_amount || 0;
  let ip = 0;
  let pp = 0;
  let ex = 0;
  let un = 0;

  const r = rate();

  for (let m = 1; m <= n; m++) {
    const e = pay(m, b.id);

    const interest = bal * r;

    const paid = Math.max(0, +e.emi_paid || 0);
    const extra = Math.max(0, +e.extra_principal || 0);

    /*
      Interest paid from normal EMI
    */
    const interestPaid = Math.min(paid, interest);

    ip += interestPaid;

    /*
      Unpaid interest
    */
    un += Math.max(0, interest - paid);

    /*
      Normal EMI principal
    */
    let principal = 0;

    if (
      m > (+loan.interest_only_months || 0)
    ) {
      principal = Math.min(
        Math.max(0, paid - interest),
        bal
      );
    }

    /*
      Extra principal always reduces principal,
      including during interest-only period.
    */
    const extraPrincipal = Math.min(
      extra,
      Math.max(0, bal - principal)
    );

    bal = Math.max(
      0,
      bal - principal - extraPrincipal
    );

    pp += principal;
    ex += extraPrincipal;
  }

  return {
    bal,
    ip,
    pp,
    ex,
    un
  };
}


/* =========================
   NAVIGATION
========================= */

function nav(id) {
  document
    .querySelectorAll(".screen")
    .forEach(x => x.classList.remove("active"));

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

  if ($("title")) {
    $("title").textContent =
      {
        dashboard: "Dashboard",
        payments: "Payments",
        people: "People",
        reports: "Reports",
        more: "More"
      }[id] || "Dream Home";
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
    x.onclick = () => nav(x.dataset.s);
  });


/* =========================
   LOAD CLOUD DATA
========================= */

async function load() {
  if (!db) {
    sync("bad");
    dashboard();
    return;
  }

  sync("");

  try {
    const q = await db.auth.getUser();

    user = q.data?.user || null;

    const l = await db
      .from("loans")
      .select("*")
      .order("created_at", {
        ascending: true
      })
      .limit(1)
      .maybeSingle();

    if (l.error) {
      console.error(l.error);
      toast(l.error.message);
      sync("bad");
      return;
    }

    loan = l.data || null;

    if (loan) {
      const [b, p] = await Promise.all([
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
        console.error(b.error);
        toast(b.error.message);
        sync("bad");
        return;
      }

      if (p.error) {
        console.error(p.error);
        toast(p.error.message);
        sync("bad");
        return;
      }

      bs = b.data || [];
      ps = p.data || [];
    } else {
      bs = [];
      ps = [];
    }

    sync("ok");

    dashboard();
  } catch (err) {
    console.error(err);
    toast(err.message || "Cloud connection error");
    sync("bad");
  }
}


/* =========================
   DASHBOARD
========================= */

function dashboard() {
  if (!loan) {
    $("dashboard").innerHTML = `
      <div class="hero">
        <small>DREAM HOME</small>
        <strong>Public view ready</strong>
        <div>
          ${
            user
              ? "Create your cloud loan to get started."
              : "Owner sign-in is required to create the cloud loan."
          }
        </div>
      </div>

      <div class="card">
        <h2>Cloud setup</h2>

        <p class="muted">
          No loan has been created yet.
        </p>

        ${
          user
            ? `
              <button
                class="btn primary"
                onclick="loanEdit()">
                🏠 Create loan
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
    `;

    return;
  }

  const a = bs.map(b => ({
    b,
    ...calc(b, loan.tenure_months)
  }));

  const remain = a.reduce(
    (x, y) => x + y.bal,
    0
  );

  const principal = a.reduce(
    (x, y) => x + y.pp + y.ex,
    0
  );

  const extra = a.reduce(
    (x, y) => x + y.ex,
    0
  );

  const interest = a.reduce(
    (x, y) => x + y.ip,
    0
  );

  $("dashboard").innerHTML = `
    <div class="hero">
      <small>REMAINING PRINCIPAL</small>

      <strong>${M(remain)}</strong>

      <div>
        ${M(loan.total_amount)}
        original ·
        ${loan.annual_rate}%
        ·
        ${loan.tenure_months} months
      </div>
    </div>

    <div class="metrics">

      <div class="metric">
        <small>Principal paid</small>
        <strong>${M(principal)}</strong>
      </div>

      <div class="metric">
        <small>Extra paid</small>
        <strong>${M(extra)}</strong>
      </div>

      <div class="metric">
        <small>Interest paid</small>
        <strong>${M(interest)}</strong>
      </div>

      <div class="metric">
        <small>Overall EMI</small>
        <strong>${M(overall())}</strong>
      </div>

    </div>

    <div class="card">

      <div class="pt">
        <h2>Borrowers</h2>

        <span class="pill">
          ${edit() ? "OWNER" : "VIEW ONLY"}
        </span>
      </div>

      ${
        a.length
          ? a
              .map(x => {
                const pct =
                  x.b.share_amount
                    ? ((x.b.share_amount - x.bal) /
                        x.b.share_amount) *
                      100
                    : 0;

                return `
                  <div class="person">

                    <div class="pt">
                      <b>${esc(x.b.name)}</b>

                      <span class="pill">
                        ${M(x.b.scheduled_emi)}/mo
                      </span>
                    </div>

                    <div class="muted">
                      Remaining principal
                    </div>

                    <div class="bal">
                      ${M(x.bal)}
                    </div>

                    <div class="bar">
                      <i
                        style="width:${Math.max(
                          0,
                          Math.min(100, pct)
                        )}%">
                      </i>
                    </div>

                    <div class="muted">
                      ${M(x.ex)} extra ·
                      ${M(x.ip)} interest
                      ${
                        x.un
                          ? ` · ⚠️ ${M(
                              x.un
                            )} unpaid interest`
                          : ""
                      }
                    </div>

                  </div>
                `;
              })
              .join("")
          : `
            <div class="empty">
              No borrowers added yet.
            </div>
          `
      }

    </div>

    <div class="actions">

      ${
        edit()
          ? `
            <button
              class="btn primary"
              onclick="payment()">
              ＋ Add payment
            </button>

            <button
              class="btn soft"
              onclick="loanEdit()">
              ⚙️ Loan settings
            </button>
          `
          : `
            <button
              class="btn soft"
              onclick="auth()">
              🔐 Owner sign in
            </button>

            <button
              class="btn soft"
              onclick="history()">
              📜 History
            </button>
          `
      }

    </div>
  `;
}


/* =========================
   PEOPLE
========================= */

function people() {
  $("people").innerHTML = `
    <div class="card">

      <div class="pt">

        <h2>Borrowers</h2>

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
          ? bs
              .map(
                b => `
                <div class="row">

                  <div>
                    <b>${esc(b.name)}</b>

                    <div class="muted">
                      Share ${M(b.share_amount)}
                      ·
                      EMI ${M(b.scheduled_emi)}
                    </div>
                  </div>

                  ${
                    edit()
                      ? `
                        <button
                          class="btn soft"
                          onclick="person('${b.id}')">
                          Edit
                        </button>
                      `
                      : ""
                  }

                </div>
              `
              )
              .join("")
          : `
            <div class="empty">
              No borrowers added.
            </div>
          `
      }

    </div>
  `;
}


/* =========================
   PAYMENTS
========================= */

function payments() {
  const months = [
    ...new Set(
      ps.map(x => +x.month_no)
    )
  ].sort((a, b) => b - a);

  $("payments").innerHTML = `
    <div class="card">

      <div class="pt">

        <div>
          <h2>Monthly payments</h2>

          <div class="muted">
            ${months.length} month(s) saved
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
          ? months
              .map(m => {
                const q = ps.filter(
                  x => +x.month_no === +m
                );

                const emiTotal =
                  q.reduce(
                    (a, x) =>
                      a +
                      (+x.emi_paid || 0),
                    0
                  );

                const extraTotal =
                  q.reduce(
                    (a, x) =>
                      a +
                      (+x.extra_principal ||
                        0),
                    0
                  );

                return `
                  <div class="row">

                    <div>
                      <b>Month ${m}</b>

                      <div class="muted">
                        EMI ${M(emiTotal)}
                        ·
                        Extra ${M(extraTotal)}
                      </div>
                    </div>

                    <span class="pill">
                      Saved
                    </span>

                  </div>
                `;
              })
              .join("")
          : `
            <div class="empty">
              No payments recorded.
            </div>
          `
      }

    </div>
  `;
}


/* =========================
   REPORTS
========================= */

function reports() {
  if (!loan) {
    $("reports").innerHTML = `
      <div class="card">
        <h2>Loan report</h2>
        <div class="empty">
          No loan has been created yet.
        </div>
      </div>
    `;
    return;
  }

  const remaining = bs.reduce(
    (a, b) =>
      a +
      calc(
        b,
        loan.tenure_months
      ).bal,
    0
  );

  $("reports").innerHTML = `
    <div class="card">

      <h2>Loan report</h2>

      <div class="row">
        <span>Original loan</span>
        <b>${M(loan.total_amount)}</b>
      </div>

      <div class="row">
        <span>Remaining principal</span>
        <b>${M(remaining)}</b>
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
        <span>Interest-only period</span>
        <b>${loan.interest_only_months || 0} months</b>
      </div>

      <div class="row">
        <span>Overall EMI</span>
        <b>${M(overall())}</b>
      </div>

    </div>
  `;
}


/* =========================
   MORE
========================= */

function more() {
  $("more").innerHTML = `
    <div class="card">

      <h2>Account</h2>

      <div class="muted">
        ${
          user
            ? "Signed in as " +
              esc(user.email) +
              " — owner editing enabled."
            : "Public view mode — owner only can edit."
        }
      </div>

      <br>

      <button
        class="btn ${
          user ? "soft" : "primary"
        }"
        onclick="${
          user ? "out()" : "auth()"
        }">

        ${
          user
            ? "Sign out"
            : "🔐 Owner sign in"
        }

      </button>

    </div>

    <div class="card">

      <h2>Manage</h2>

      ${
        edit()
          ? `
            <div class="row">

              <b>Loan settings</b>

              <button
                class="btn soft"
                onclick="loanEdit()">
                Open
              </button>

            </div>

            <div class="row">

              <b>Borrowers</b>

              <button
                class="btn soft"
                onclick="person()">
                Open
              </button>

            </div>
          `
          : ""
      }

      <div class="row">

        <b>Payment history</b>

        <button
          class="btn soft"
          onclick="history()">
          Open
        </button>

      </div>

    </div>
  `;
}


/* =========================
   MODAL
========================= */

function modal(h) {
  $("mb").innerHTML = h;
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


/* =========================
   ACCOUNT BUTTON
========================= */

/*
  THIS WAS MISSING IN THE OLD VERSION.
*/

if ($("account")) {
  $("account").onclick = () => {
    auth();
  };
}


/* =========================
   AUTHENTICATION
========================= */

function auth() {
  if (!db) {
    toast(
      "Supabase is not configured."
    );
    return;
  }

  modal(`
    <h2>Owner sign in</h2>

    <p class="muted">
      Only the owner account can edit
      cloud data.
    </p>

    <label>
      Email
      <input
        id="ae"
        type="email"
        autocomplete="email">
    </label>

    <label>
      Password
      <input
        id="ap"
        type="password"
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
  `);
}

async function login() {
  if (!db) {
    toast("Supabase is not configured.");
    return;
  }

  const email =
    $("ae").value.trim();

  const password =
    $("ap").value;

  if (!email || !password) {
    toast(
      "Enter email and password."
    );
    return;
  }

  const q =
    await db.auth.signInWithPassword({
      email,
      password
    });

  if (q.error) {
    toast(q.error.message);
    return;
  }

  user = q.data.user;

  close();

  await load();

  toast("Signed in successfully.");
}

async function signup() {
  if (!db) {
    toast("Supabase is not configured.");
    return;
  }

  const email =
    $("ae").value.trim();

  const password =
    $("ap").value;

  if (!email || !password) {
    toast(
      "Enter email and password."
    );
    return;
  }

  if (password.length < 6) {
    toast(
      "Password must be at least 6 characters."
    );
    return;
  }

  const q =
    await db.auth.signUp({
      email,
      password
    });

  if (q.error) {
    toast(q.error.message);
    return;
  }

  if (q.data.user) {
    user = q.data.user;

    close();

    /*
      If email confirmation is enabled,
      Supabase may not give us an active
      session until the email is confirmed.
    */
    if (!q.data.session) {
      toast(
        "Account created. Check your email and confirm the account."
      );
    } else {
      toast(
        "Owner account created."
      );
    }

    await load();
  }
}

async function out() {
  if (!db) return;

  await db.auth.signOut();

  user = null;

  await load();

  toast("Signed out.");
}


/* =========================
   LOAN SETTINGS / CREATE LOAN
========================= */

function loanEdit() {
  if (!user) {
    auth();
    return;
  }

  /*
    If no loan exists, this form creates one.
    If a loan exists, it edits the existing loan.
  */

  const creating = !loan;

  const current = loan || {
    name: "Dream Home Loan",
    total_amount: 0,
    annual_rate: 8.9,
    tenure_months: 240,
    start_date:
      new Date()
        .toISOString()
        .slice(0, 10),
    interest_only_months: 0,
    emi_mode: "manual",
    manual_emi: 0
  };

  modal(`
    <h2>
      ${
        creating
          ? "Create loan"
          : "Loan settings"
      }
    </h2>

    <div class="grid">

      <label class="full">
        Loan name
        <input
          id="ln"
          value="${esc(current.name)}">
      </label>

      <label>
        Total loan amount
        <input
          id="la"
          type="number"
          min="0"
          step="1"
          value="${current.total_amount}">
      </label>

      <label>
        Annual interest %
        <input
          id="lr"
          type="number"
          min="0"
          step="0.01"
          value="${current.annual_rate}">
      </label>

      <label>
        Tenure months
        <input
          id="lt"
          type="number"
          min="1"
          value="${current.tenure_months}">
      </label>

      <label>
        Start date
        <input
          id="ls"
          type="date"
          value="${current.start_date || ""}">
      </label>

      <label>
        Interest-only months
        <input
          id="li"
          type="number"
          min="0"
          value="${current.interest_only_months || 0}">
      </label>

      <label>
        EMI mode

        <select id="lm">

          <option
            value="auto"
            ${
              current.emi_mode === "auto"
                ? "selected"
                : ""
            }>
            Auto
          </option>

          <option
            value="manual"
            ${
              current.emi_mode === "manual"
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
          min="0"
          value="${current.manual_emi || ""}">
      </label>

    </div>

    <p class="muted">
      During the interest-only period,
      regular EMI does not reduce principal.
      Extra principal always reduces the
      corresponding borrower's principal.
    </p>

    <button
      class="btn primary"
      onclick="saveLoan()">

      ${
        creating
          ? "Create loan"
          : "Save changes"
      }

    </button>
  `);
}

async function saveLoan() {
  if (!db || !user) {
    auth();
    return;
  }

  const total =
    +$("la").value || 0;

  const annualRate =
    +$("lr").value || 0;

  const tenure =
    +$("lt").value || 0;

  const interestOnly =
    +$("li").value || 0;

  if (total <= 0) {
    toast(
      "Enter a valid loan amount."
    );
    return;
  }

  if (annualRate < 0) {
    toast(
      "Enter a valid interest rate."
    );
    return;
  }

  if (tenure <= 0) {
    toast(
      "Enter a valid tenure."
    );
    return;
  }

  if (interestOnly > tenure) {
    toast(
      "Interest-only period cannot exceed tenure."
    );
    return;
  }

  const v = {
    name:
      $("ln").value.trim() ||
      "Dream Home Loan",

    total_amount: total,

    annual_rate: annualRate,

    tenure_months: tenure,

    start_date: $("ls").value || null,

    interest_only_months:
      interestOnly,

    emi_mode:
      $("lm").value,

    manual_emi:
      +$("le").value || 0,

    updated_at:
      new Date().toISOString()
  };

  let q;

  /*
    CREATE FIRST LOAN
  */

  if (!loan) {
    q = await db
      .from("loans")
      .insert({
        ...v,
        created_by: user.id
      })
      .select()
      .single();
  }

  /*
    UPDATE EXISTING LOAN
  */

  else {
    q = await db
      .from("loans")
      .update(v)
      .eq("id", loan.id)
      .eq("created_by", user.id)
      .select()
      .single();
  }

  if (q.error) {
    console.error(q.error);
    toast(q.error.message);
    return;
  }

  loan = q.data;

  close();

  await load();

  toast(
    !loan
      ? "Loan created."
      : "Loan saved."
  );
}


/* =========================
   BORROWER
========================= */

function person(id) {
  if (!edit()) {
    auth();
    return;
  }

  const b =
    bs.find(x => x.id === id) || {
      name: "New Person",
      share_amount: 0,
      scheduled_emi: 0
    };

  modal(`
    <h2>
      ${id ? "Edit" : "Add"} borrower
    </h2>

    <label>
      Name
      <input
        id="bn"
        value="${esc(b.name)}">
    </label>

    <div class="grid">

      <label>
        Share amount
        <input
          id="bsx"
          type="number"
          min="0"
          value="${b.share_amount}">
      </label>

      <label>
        Monthly EMI
        <input
          id="be"
          type="number"
          min="0"
          value="${b.scheduled_emi}">
      </label>

    </div>

    <button
      class="btn primary"
      onclick="savePerson('${id || ""}')">

      Save borrower

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
  if (!edit()) {
    auth();
    return;
  }

  const share =
    +$("bsx").value || 0;

  const scheduled =
    +$("be").value || 0;

  if (share < 0) {
    toast("Invalid share amount.");
    return;
  }

  const v = {
    loan_id: loan.id,

    name:
      $("bn").value.trim() ||
      "Person",

    share_amount: share,

    scheduled_emi: scheduled,

    sort_order: id
      ? (
          bs.find(
            x => x.id === id
          )?.sort_order || 0
        )
      : bs.length
  };

  let q;

  if (id) {
    q = await db
      .from("borrowers")
      .update(v)
      .eq("id", id)
      .select()
      .single();
  } else {
    q = await db
      .from("borrowers")
      .insert(v)
      .select()
      .single();
  }

  if (q.error) {
    console.error(q.error);
    toast(q.error.message);
    return;
  }

  close();

  await load();

  toast("Borrower saved.");
}

async function delPerson(id) {
  if (!edit()) {
    auth();
    return;
  }

  if (
    !confirm(
      "Delete borrower and their payments?"
    )
  ) {
    return;
  }

  const q = await db
    .from("borrowers")
    .delete()
    .eq("id", id);

  if (q.error) {
    toast(q.error.message);
    return;
  }

  close();

  await load();

  toast("Borrower deleted.");
}


/* =========================
   MONTHLY PAYMENT
========================= */

function payment() {
  if (!edit()) {
    auth();
    return;
  }

  if (!bs.length) {
    toast(
      "Add borrowers before entering payments."
    );
    return;
  }

  const defaultMonth =
    ps.length
      ? Math.max(
          ...ps.map(
            x => +x.month_no
          )
        ) + 1
      : 1;

  let m = +prompt(
    "Month number (1-" +
      loan.tenure_months +
      ")",
    defaultMonth
  );

  if (
    !m ||
    m < 1 ||
    m > loan.tenure_months
  ) {
    return;
  }

  modal(`
    <h2>
      Month ${m} payment
    </h2>

    <p class="muted">
      Enter the actual EMI paid and any
      extra principal paid for each borrower.
    </p>

    <div id="prs"></div>

    <button
      class="btn primary"
      onclick="savePayment(${m})">

      Save to cloud

    </button>
  `);

  $("prs").innerHTML = bs
    .map(b => {
      const e = pay(m, b.id);

      const before =
        calc(b, m - 1);

      const interest =
        before.bal * rate();

      return `
        <div class="pay">

          <b>
            ${esc(b.name)}
          </b>

          <div class="grid">

            <label>
              Scheduled EMI

              <input
                disabled
                value="${Math.round(
                  b.scheduled_emi
                )}">
            </label>

            <label>
              Actual EMI

              <input
                id="e${b.id}"
                type="number"
                min="0"
                value="${
                  e.emi_paid || ""
                }">
            </label>

            <label>
              Extra principal

              <input
                id="x${b.id}"
                type="number"
                min="0"
                value="${
                  e.extra_principal || ""
                }">
            </label>

            <label>
              Opening principal

              <input
                disabled
                value="${M(before.bal)}">
            </label>

          </div>

          <div class="calc">

            Interest due:
            <b>${M(interest)}</b>

            <br>

            ${
              m <=
              (+loan.interest_only_months ||
                0)
                ? `
                  Interest-only month:
                  regular EMI will not reduce
                  principal.
                `
                : `
                  EMI above interest can reduce
                  principal.
                `
            }

          </div>

        </div>
      `;
    })
    .join("");
}

async function savePayment(m) {
  if (!edit()) {
    auth();
    return;
  }

  for (const b of bs) {
    const v = {
      loan_id: loan.id,

      borrower_id: b.id,

      month_no: m,

      payment_date:
        new Date()
          .toISOString()
          .slice(0, 10),

      emi_paid:
        +$(
          "e" + b.id
        ).value || 0,

      extra_principal:
        +$(
          "x" + b.id
        ).value || 0
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
      console.error(q.error);
      toast(q.error.message);
      return;
    }
  }

  close();

  await load();

  toast(
    "Payment saved to cloud."
  );
}


/* =========================
   HISTORY
========================= */

function history() {
  if (!loan) {
    toast(
      "No loan has been created yet."
    );
    return;
  }

  let rows = "";

  for (
    let m = 1;
    m <= loan.tenure_months;
    m++
  ) {
    for (const b of bs) {
      const e = pay(m, b.id);

      if (
        !e.emi_paid &&
        !e.extra_principal
      ) {
        continue;
      }

      rows += `
        <tr>

          <td>${m}</td>

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
              calc(
                b,
                m
              ).bal
            )}
          </td>

        </tr>
      `;
    }
  }

  modal(`
    <h2>
      Payment history
    </h2>

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


/* =========================
   SUPABASE AUTH STATE
========================= */

if (db) {
  db.auth.onAuthStateChange(
    () => {
      setTimeout(
        () => load(),
        0
      );
    }
  );

  load();
} else {
  sync("bad");
  dashboard();
}


/* =========================
   SERVICE WORKER
========================= */

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


/* =========================
   INITIAL SCREEN
========================= */

nav("dashboard");
