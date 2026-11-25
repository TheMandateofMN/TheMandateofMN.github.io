/*
 * The page the corpus is kept from. Without this it still works: each piece
 * has its status in a list with a button beside it to set it by, and the
 * pieces stay in the order they are in. With it, a status is saved as soon as
 * it is chosen, and a piece is moved up or down its table by the handle at
 * the start of its row, dragged or with the arrow keys.
 */

(() => {
  "use strict";

  // what was just done is said for those who cannot see it happen
  const said = document.createElement("p");
  said.className = "visually-hidden";
  said.setAttribute("role", "status");
  document.getElementById("main")?.append(said);
  const say = (words) => {
    said.textContent = "";
    // said again even when it is the same words as last time
    requestAnimationFrame(() => (said.textContent = words));
  };

  const post = (form) =>
    fetch(form.action, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(new FormData(form)),
    });

  /* ------------------------------------------------------------- status */

  for (const form of document.querySelectorAll("form[data-status]")) {
    const select = form.querySelector("select");
    const button = form.querySelector("button");
    if (!select) continue;
    if (button) button.hidden = true;
    let was = select.value;
    select.addEventListener("change", async () => {
      select.disabled = false;
      form.classList.add("is-saving");
      try {
        const response = await post(form);
        if (!response.ok) throw new Error(String(response.status));
        was = select.value;
        say(`${select.selectedOptions[0]?.textContent || "Status"}: saved.`);
      } catch {
        // put back to what it is known to be, and said
        select.value = was;
        say("That could not be saved. Try again.");
        window.alert("That status could not be saved. Try again.");
      } finally {
        form.classList.remove("is-saving");
      }
    });
  }

  /* -------------------------------------------------------------- order */

  const orderForm = document.querySelector("form[data-order-form]");
  if (!orderForm) return;

  const rowsOf = (body) => [...body.querySelectorAll(":scope > tr[data-id]")];
  const orderOf = (body) => rowsOf(body).map((row) => row.dataset.id).join(" ");

  // one saving at a time for each table, and always the latest order
  const saving = new WeakMap();
  async function keep(body) {
    if (saving.get(body)) return saving.set(body, "again");
    saving.set(body, "now");
    orderForm.elements.ids.value = orderOf(body);
    let kept = false;
    try {
      kept = (await post(orderForm)).ok;
    } catch {
      kept = false;
    }
    const again = saving.get(body) === "again";
    saving.delete(body);
    if (again) return keep(body);
    say(kept ? "Order saved." : "The order could not be saved.");
    if (!kept) window.alert("The new order could not be saved. Load the page again to see the order as it stands.");
  }

  for (const body of document.querySelectorAll("tbody[data-order]")) {
    let came = orderOf(body);
    const settle = () => {
      const now = orderOf(body);
      if (now === came) return;
      came = now;
      keep(body);
    };

    for (const row of rowsOf(body)) {
      const grip = row.querySelector("[data-grip]");
      if (!grip) continue;
      grip.hidden = false;

      /* by hand: the row follows the pointer past the middle of its neighbours */
      let held = null;
      grip.addEventListener("pointerdown", (event) => {
        if (event.button > 0) return;
        held = event.pointerId;
        grip.setPointerCapture(held);
        row.classList.add("is-moving");
        body.classList.add("is-ordering");
        event.preventDefault();
      });
      grip.addEventListener("pointermove", (event) => {
        if (event.pointerId !== held) return;
        for (;;) {
          const before = row.previousElementSibling;
          const after = row.nextElementSibling;
          const middle = (other) => {
            const box = other.getBoundingClientRect();
            return box.top + box.height / 2;
          };
          if (before && event.clientY < middle(before)) before.before(row);
          else if (after && event.clientY > middle(after)) after.after(row);
          else break;
        }
      });
      const drop = (event) => {
        if (event.pointerId !== held) return;
        held = null;
        row.classList.remove("is-moving");
        body.classList.remove("is-ordering");
        settle();
      };
      grip.addEventListener("pointerup", drop);
      grip.addEventListener("pointercancel", drop);

      /* by the keys: up and down a row at a time, to the top with Home and the bottom with End */
      grip.addEventListener("keydown", (event) => {
        const rows = rowsOf(body);
        const at = rows.indexOf(row);
        const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: rows.length - 1 }[event.key];
        if (to === undefined) return;
        event.preventDefault();
        if (to < 0 || to >= rows.length || to === at) return;
        if (to < at) rows[to].before(row);
        else rows[to].after(row);
        grip.focus();
        say(`Now ${to + 1} of ${rows.length}.`);
        settle();
      });
    }
  }
})();
