import http from "node:http";

const FOOD_DEMO_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FoodFlow Demo Ordering</title>
    <style>
      :root {
        --bg: #f8f6ee;
        --panel: #ffffff;
        --accent: #c75000;
        --accent-dark: #8b3600;
        --text: #1b1b1b;
        --muted: #5e5e5e;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: var(--text);
        background: radial-gradient(circle at top right, #fff5db, var(--bg) 45%);
      }
      header {
        padding: 24px 28px;
        border-bottom: 1px solid #ece8db;
        background: #fffaf2;
      }
      h1 {
        margin: 0;
        font-size: 28px;
      }
      .sub {
        margin-top: 8px;
        color: var(--muted);
      }
      main {
        display: grid;
        grid-template-columns: 1fr 340px;
        gap: 20px;
        padding: 20px;
      }
      .menu-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 14px;
      }
      .card,
      .panel {
        background: var(--panel);
        border-radius: 12px;
        border: 1px solid #eee4cf;
        padding: 14px;
      }
      .item-title {
        margin: 0 0 8px;
        font-size: 18px;
      }
      .item-meta {
        color: var(--muted);
        margin-bottom: 10px;
      }
      button {
        background: var(--accent);
        border: none;
        color: #fff;
        border-radius: 8px;
        padding: 10px 12px;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover {
        background: var(--accent-dark);
      }
      button.secondary {
        background: #f0e8d4;
        color: #1f1f1f;
      }
      .cart-item {
        display: flex;
        justify-content: space-between;
        margin: 8px 0;
      }
      .cart-total {
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid #f0eadb;
        font-weight: 700;
      }
      .checkout-flow {
        margin-top: 18px;
        background: #fff;
        border: 1px solid #eadfca;
        border-radius: 12px;
        padding: 18px;
      }
      .flow-step {
        display: none;
      }
      .flow-step.active {
        display: block;
      }
      label {
        display: block;
        margin: 8px 0 4px;
        font-weight: 600;
      }
      input {
        width: 100%;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid #d7d7d7;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 14px;
      }
      .warning {
        margin-top: 12px;
        padding: 10px;
        border-radius: 8px;
        background: #fff2f0;
        border: 1px solid #f5cdc7;
        color: #7b1f16;
        font-weight: 600;
      }
      .muted {
        color: var(--muted);
      }
      @media (max-width: 900px) {
        main {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>FoodFlow Demo Ordering</h1>
      <p class="sub">A local demo app for autonomous browser-agent testing.</p>
    </header>
    <main>
      <section>
        <h2>Menu</h2>
        <div id="menu" class="menu-grid" aria-label="Food menu"></div>
        <section class="checkout-flow" aria-label="Checkout flow">
          <div id="step-details" class="flow-step">
            <h3>Delivery details</h3>
            <p class="muted">Enter address details to continue.</p>
            <label for="customerName">Customer name</label>
            <input id="customerName" name="customerName" placeholder="Jane Smith" />
            <label for="deliveryAddress">Delivery address</label>
            <input id="deliveryAddress" name="deliveryAddress" placeholder="123 Main St" />
            <label for="phoneNumber">Phone number</label>
            <input id="phoneNumber" name="phoneNumber" placeholder="+1 555 123 4567" />
            <div class="actions">
              <button id="continueToReview">Continue to review</button>
            </div>
          </div>
          <div id="step-review" class="flow-step">
            <h3>Review order</h3>
            <div id="reviewList"></div>
            <div class="actions">
              <button id="backToDetails" class="secondary">Back to details</button>
              <button id="proceedToPayment">Proceed to payment</button>
            </div>
          </div>
          <div id="step-payment" class="flow-step">
            <h3>Payment confirmation</h3>
            <p>Review your order and confirm payment when ready.</p>
            <div class="warning">
              Demo safety note: stop before clicking "Pay now".
            </div>
            <div class="actions">
              <button id="backToReview" class="secondary">Back to review</button>
              <button id="payNow">Pay now</button>
            </div>
          </div>
        </section>
      </section>
      <aside class="panel">
        <h2>Cart</h2>
        <p id="emptyCartMessage">Your cart is empty.</p>
        <div id="cartItems"></div>
        <div class="cart-total" id="cartTotal">Total: $0.00</div>
        <div class="actions">
          <button id="checkoutButton" disabled>Checkout</button>
        </div>
      </aside>
    </main>
    <script>
      const menuItems = [
        { id: "margarita", name: "Margherita Pizza", price: 12.5, category: "Pizza" },
        { id: "pepperoni", name: "Pepperoni Pizza", price: 14.0, category: "Pizza" },
        { id: "caesar", name: "Caesar Salad", price: 8.5, category: "Salad" },
        { id: "wings", name: "Buffalo Wings", price: 9.5, category: "Snacks" },
        { id: "cola", name: "Cola", price: 2.8, category: "Drink" }
      ];

      const state = {
        cart: new Map(),
        flow: "menu"
      };

      const menuElement = document.getElementById("menu");
      const cartItemsElement = document.getElementById("cartItems");
      const cartTotalElement = document.getElementById("cartTotal");
      const emptyCartMessage = document.getElementById("emptyCartMessage");
      const checkoutButton = document.getElementById("checkoutButton");

      function formatPrice(amount) {
        return "$" + amount.toFixed(2);
      }

      function renderMenu() {
        menuElement.innerHTML = "";
        for (const item of menuItems) {
          const card = document.createElement("article");
          card.className = "card";

          const title = document.createElement("h3");
          title.className = "item-title";
          title.textContent = item.name;

          const meta = document.createElement("p");
          meta.className = "item-meta";
          meta.textContent = item.category + " • " + formatPrice(item.price);

          const button = document.createElement("button");
          button.textContent = "Add to cart";
          button.setAttribute("aria-label", "Add " + item.name + " to cart");
          button.addEventListener("click", () => {
            const current = state.cart.get(item.id);
            if (current) {
              current.quantity += 1;
            } else {
              state.cart.set(item.id, {
                id: item.id,
                name: item.name,
                price: item.price,
                quantity: 1
              });
            }
            renderCart();
          });

          card.appendChild(title);
          card.appendChild(meta);
          card.appendChild(button);
          menuElement.appendChild(card);
        }
      }

      function renderCart() {
        cartItemsElement.innerHTML = "";

        let total = 0;
        let items = 0;
        for (const value of state.cart.values()) {
          items += value.quantity;
          total += value.price * value.quantity;

          const row = document.createElement("div");
          row.className = "cart-item";
          row.innerHTML =
            "<span>" +
            value.name +
            " x" +
            value.quantity +
            "</span><strong>" +
            formatPrice(value.price * value.quantity) +
            "</strong>";
          cartItemsElement.appendChild(row);
        }

        emptyCartMessage.style.display = items === 0 ? "block" : "none";
        checkoutButton.disabled = items === 0;
        cartTotalElement.textContent = "Total: " + formatPrice(total);
      }

      function showStep(step) {
        state.flow = step;
        for (const id of ["step-details", "step-review", "step-payment"]) {
          const element = document.getElementById(id);
          element.classList.remove("active");
        }
        if (step === "details") {
          document.getElementById("step-details").classList.add("active");
        }
        if (step === "review") {
          document.getElementById("step-review").classList.add("active");
          const reviewList = document.getElementById("reviewList");
          reviewList.innerHTML = "";
          for (const value of state.cart.values()) {
            const line = document.createElement("p");
            line.textContent =
              value.name + " x" + value.quantity + " — " + formatPrice(value.price * value.quantity);
            reviewList.appendChild(line);
          }
        }
        if (step === "payment") {
          document.getElementById("step-payment").classList.add("active");
        }
      }

      document.getElementById("checkoutButton").addEventListener("click", () => {
        showStep("details");
      });

      document.getElementById("continueToReview").addEventListener("click", () => {
        showStep("review");
      });

      document.getElementById("backToDetails").addEventListener("click", () => {
        showStep("details");
      });

      document.getElementById("proceedToPayment").addEventListener("click", () => {
        showStep("payment");
      });

      document.getElementById("backToReview").addEventListener("click", () => {
        showStep("review");
      });

      document.getElementById("payNow").addEventListener("click", () => {
        alert("Demo payment triggered. In assignment demos, the agent should stop before this click.");
      });

      renderMenu();
      renderCart();
    </script>
  </body>
</html>`;

export interface DemoServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startFoodDemoServer(port = 4173): Promise<DemoServerHandle> {
  const server = http.createServer((request, response) => {
    if (!request.url || request.url === "/" || request.url.startsWith("/index")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(FOOD_DEMO_HTML);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
