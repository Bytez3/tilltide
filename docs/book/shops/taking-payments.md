# Taking payments

The **Charge** screen is the till. The teal band at the top shows how the customer is paying and the total.

## 1. Build the sale

* **From the menu:** tap items to add them. A number on the tile shows how many. Tap a chip under the total (like **2× Pasty −**) to take one off.
* **On the keypad:** switch to **Keypad** and type a price. With items in the basket as well, the typed amount is added as **Other**.

Prices for menu items always come from your menu on the server, so nobody can change them at the till.

## 2. Choose how they're paying

Pick from the switch at the top: **PayPal**, **Wallet**, **Cash** or **Card**.

### PayPal (or a bank card)

1. If the customer has a **loyalty code** from an earlier receipt, tap **+ Loyalty code** and type it. Their points come off the bill.
2. Tap **Charge**. A QR code appears.
3. The customer scans it with their phone camera and pays with PayPal or a card on PayPal's page.
4. The till turns green: **Paid**.

The money goes to your PayPal account.

### Wallet (PYUSD or USDC)

For customers with a Solana wallet. The price is in pounds, and the QR code asks for the right amount of PYUSD (or USDC) at today's exchange rate.

* Tap **+ Let them use points** if the customer wants to spend loyalty points. Their wallet then pays the rest and uses up the points in one step.
* Customers paying from a Solana Seeker phone can earn bonus points (see [Loyalty points](loyalty.md)).

The money goes to your till wallet. You send it to yourself later (see [Sending takings to yourself](sending-takings.md)).

### Cash

1. Tap **Cash**, build the sale, and optionally tap **+ Work out change** and type what they handed you. The till shows the change.
2. Tap **Record cash sale**.

Nothing moves through Tilltide. It's recorded so your day's books are complete.

### Card (your own card reader)

Take the payment on your existing card reader as usual, then tap **Card** and **Record card sale**, so it appears in your takings and reports.

## 3. After the sale

The **Paid** screen shows a second QR code: **Receipt and points**. The customer scans it for a receipt that shows their points and their loyalty code. Tap **New sale** to start the next one.

{% hint style="info" %}
If the phone loses its connection, a banner appears at the top. Sales already on screen still show as paid once it's back. Use your card reader for new sales meanwhile.
{% endhint %}
