# ZNK Bot

Discord bot for tickets, sales, vouches, invites and moderation, with a web dashboard.

## Highlights

- **Add / remove a member from a ticket**: `/add` and `/remove` (or `/ticket ajouter` and `/ticket retirer`) inside the ticket, with the member mention.
- **Vouch button (no slash command)**: enable it per ticket configuration. The ticket opening message then shows a **⭐ Vouch** button. Clicking it opens a 1–5 star picker, then a form for the message. The review is published in a dedicated channel.
- **Vouch moderation**: in the vouch channel, staff can open the **ticket logs** and delete any vouch that is not legit. Deleting a vouch also removes its Discord message.
- **Ticket stats button**: add a **📊 Stats** button to any ticket panel. The stats panel is fully editable in **Tickets → Stats**: button text/emoji/color, title, description, color, image, logo, footer, star rating with the review count, field names and visibility, plus free `Name | Value` fields with variables.
- **Role claim panel**: a **Roles** tab lets you build a fully customizable panel (title, description, image, logo, color, footer, one button per role with its own text, emoji and color) and send it to a dedicated channel. Members click to get the role; clicking again removes it (optional). The message stays in sync when you edit a role.
- **Cross-server auto role**: a dedicated **Role auto** tab grants a role on another Discord server when a member joins (or rejoins) the selected server. The bot handles members who are not yet on the target server by keeping a pending grant, applied as soon as they join it.
- **Vouch-gated closing**: a customer cannot close their ticket without leaving a vouch. They can instead click **Ask a staff member**, which mentions the ticket role; staff can close without a vouch.
- **Multi-button panel**: a banner, a text and **one button per category** (7 to 9 depending on the banner, Discord limit). Each button opens its category and, if a sub-panel is linked, the first menu of the flow. Rendered with the recent Discord components (button on the right of each text) and automatic fallback to embed + buttons on older discord.js versions.
- **Custom ticket fields**: in the opening message, add as many fields as you want (name + value, 10 maximum) under the description: price, service, delay… Check **Side by side** on a field to display it next to the others (3 per row, like Discord); unchecked, the name is above the value on the full width. **All side by side** / **All stacked** buttons switch every field at once. Variables `{prix}`, `{paiement}`, `{order}`, `{category}`… are available. Fields automatically replace the two default text lines, and a checkbox removes those lines even without fields.
- **Automatic translation**: in tickets, every received message is translated to French and English, whatever the source language. A French message gets its English translation (🇬🇧), an English message its French translation (🇫🇷), and a message in another language gets both. Mentions, links and emojis are preserved. Can be enabled per configuration or per panel.
- **Sales tracking**: when a ticket is closed, the bot asks whether the sale was completed. Staff enters the amount, buyer and product. A dedicated panel shows the number of sales, money generated, average basket and latest sales.
- **Global color**: one color for every panel (tickets, vouches, sales), configurable from the dashboard or `/ticket couleur`.
- **Live dashboard preview**: the right side of the dashboard shows an **exact preview** of the message that will be sent. It updates as you type, and you can **click a title, description, footer or button to edit its text directly** in the preview.
- **Reusable panels**: in **Tickets → Panels**, **📋 Duplicate** copies an already-sent panel into the form so you can change a few things and send a new message, without touching the original.
- **Member backup / restore**: save every member (name + roles). If the server is banned or recreated, the bot creates a permanent invite and DMs every saved member; roles are restored by name when they join.
- **Giveaway / sanction panels**: in **Announcements**, choose the **@ of anyone** shown as the giveaway creator (“Organized by”) or as the moderator (“banned by”). Type `@pseudo`, `<@ID>` or the raw ID; the bot turns it into a real mention. The “Organized by”, ban and mute texts are customizable with variables. Empty = the person who ran the command / the default text.
- **Simplified dashboard**: sections for Home, Tickets, Roles, Role auto, Vouches, Sales, Products, Restock, Images, Admin, Announcements, Appearance, Invites, Commands, Backup.
- **Complete Supabase backup**: `supabase.sql` contains the main table, the history and views to read invites, panels, vouches and sales.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TOKEN` | Yes | Discord bot token. |
| `PANEL_PASSWORD` | Yes | Web dashboard password. |
| `PORT` | No | Dashboard port (Railway provides it automatically). |
| `DB_FILE` | Recommended | JSON file path, e.g. `/data/data.json` on Railway. |
| `RAILWAY_VOLUME_MOUNT_PATH` | No | Filled automatically by Railway when a volume is mounted. |
| `SUPABASE_URL` | Yes (recommended) | Supabase project URL (`https://xxxx.supabase.co`). |
| `SUPABASE_KEY` | Yes (recommended) | Supabase **service_role** key (never the anon key). |
| `SUPABASE_SERVICE_KEY` | No | Alias accepted instead of `SUPABASE_KEY`. |
| `SUPABASE_ALLOW_SHRINK` | No | `1` to allow overwriting with smaller data (safety guard disabled). |

Full example: see `.env.example`.

## Supabase setup

1. Create a project on [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the whole content of `supabase.sql`, then **Run**.
3. Get the project URL and the **service_role** key from **Project Settings → API**.
4. Add `SUPABASE_URL` and `SUPABASE_KEY` in Railway (or in `.env`).

The bot reloads Supabase on startup: panels, categories, invites, vouches and sales are restored after a redeploy.

## Discord intents

In the Discord developer portal → your application → Bot:

- **Server Members Intent**: enabled.
- **Message Content Intent**: enabled (ticket transcripts).

Bot permissions: Manage Channels, Manage Roles, Manage Messages, View Channels, Send Messages, Attach Files, Embed Links. The bot role must be above the staff roles.

## Useful commands

### Tickets

- `/ticket config-creer`, `config-liste`, `config-supprimer`
- `/ticket staff-ajouter`, `staff-retirer`
- `/ticket ajouter`, `/ticket retirer` (inside a ticket)
- `/add`, `/remove` — quick versions, usable by the ticket creator and staff (inside the ticket)
- `/ticket raison-ajouter`, `raison-modifier`, `raison-retirer`
- `/ticket panel`, `/ticket message`, `/ticket bouton`
- `/ticket couleur` (global or per-configuration color)
- `/ticket vouch-salon`, `vouch-activer`, `vouch-desactiver` (vouch channel and Vouch button availability)
- `/ticket traduction-activer`, `traduction-desactiver` (automatic translation any language → French + English)
- `/ticket ventes-salon`, `ventes-panel`, `ventes-devise`

### Products & Restock

Two fully customizable shop posts, available as commands and from the dashboard (**Products** and **Restock** pages):

- `/product creer` — **product post**: title, free Markdown description, image, logo, footer and **as many link buttons as you want** (25 maximum, Discord limit). Each button is written `Text | link or channel | emoji` (emoji optional).
- `/restock creer` — **restock table**: `Variant | Price | Stock` rows, image, logo, footer and link buttons.

Common options: `salon`, `couleur`, `logo` (checked by default, uncheck to hide the logo) and mentions (`mention`, `ping`). From the dashboard, rows, links and images are entered directly (add/remove buttons) without a command.

A button can point to a website **or a Discord channel**: in the dashboard, choose the channel in “ou salon (achat direct)”, or write `#channel-name` / `<#ID>` / the channel ID in the command. The button then opens the purchase channel directly, without an intermediate link. Unicode emojis on buttons are placed in the label so they align perfectly with the text.

To put **any text in bold**, select it in a Markdown field and click **G** in the formatting bar at the top of the page (or `Ctrl+B`). Bold works in descriptions, variants, prices, stock, panel texts, etc.

Every post is **remembered** in the **Products** / **Restock** page:

- **✏️ Edit** reloads all parameters into the form (title, text, links, image, logo, color, footer…). Change what you want then click **Update the message**: the Discord message is edited directly, without creating a new one.
- **📤 Resend** publishes a copy with the same parameters (or the parameters currently shown in the form).
- **🗑️** deletes the Discord message and the list entry.

No need to start over: a sent message stays editable and reusable.

### Automatic restock announcement

Each choice of a sub-panel has a stock status. In **Tickets → Sub-panels**, open a sub-panel and click **Plus en stock** on a choice: the choice then shows **⛔ Out of stock** in the Discord menu, and members who select it are told it is out of stock.

Click **Remettre en stock** to put it back: the bot immediately posts an automatic message with the choice name in the channel configured at the top of the **Restock** page (**Automatic restock announcement**). The title, text above the embed, description, image, logo/thumbnail, footer and color are editable there, with variables `{choice}`, `{price}`, `{sub}`, `{config}` and `{server}`. Default: `📦 Restock` / `**{choice}** est de nouveau en stock !`. The **Send a test** button posts a preview in the channel without changing any choice.

### Images: link, upload and library

Everywhere an image is requested (ticket panels, sub-panels, opening message, products, restock, server logos, vouch), you can:

- paste a **link** (`https://…`);
- **upload a file** from the dashboard. The image is automatically resized and compressed in the browser (phone photos accepted), then sent with the Discord message as an attachment: it does not depend on any external hosting;
- choose an image already saved in the **library** (dropdown under each image field).

The **Images** page manages the library: add a file or link, give it a simple **name**, rename it, delete it and copy its link. Images are stored in Supabase with the server (40 maximum) and reusable everywhere in one click. The **＋ Library** button under an image field saves the image already selected.

The **global logo** is set in **Appearance** and applies to all panels, messages and posts. Each **Products** / **Restock** post, each ticket panel, each sub-panel, the opening message, vouches and the sales panel also have their **own logo**: choose it in the “Logo” field (link, uploaded file or library image), it appears in the top right. Empty = global logo (if the corresponding checkbox is checked).

### Command access (Admin tab)

The **Admin** tab lets you choose precisely who can use each command:

- **Per command** or **per command category** (Shop, Tickets, Moderation…).
- For a **role** or a **person** (search by name), with the list of current accesses and a button to remove each one.
- **Allow everything** immediately gives **all commands** to a role or a person (full access).
- The public commands are limited to **`/help` and `/invites`**: a member with no permission only has these two. Owner-only commands cannot be delegated.
- The private command channel is updated automatically with the allowed roles and people.

The same settings exist on the Discord side with `/permissions` and `/permissions-categorie` (roles); the dashboard adds per-person authorizations and the “allow everything” button.

### Ticket staff roles

In **Tickets → Settings**:

- Add **as many staff roles as you want** (Ctrl + click), or **no role** (then only administrators and the member who opens the ticket can see it).
- **Staff access**: “At least one role is enough” (classic behavior) or “**All roles are required**”: a member must have every staff role of the category to see the ticket. In “all roles” mode, access is recalculated automatically when a member's roles change.
- Each **menu category** and each **sub-panel choice** can have its **own staff roles** (several) and its own access mode. A ticket from that category uses these roles instead of the configuration ones.

### Ticket panels

Everything is configured from the dashboard, **Tickets** tab:

- **Categories**: each category has a name, an emoji, a short description, a **panel text** (shown to the left of the button in a multi-button panel) and a **button text** (the label displayed on the button; empty = the category name). Each category also has a **Next sub-panel** field: when a member clicks that category, the linked sub-panel opens so they can choose an offer. `Default` uses the default sub-panel, `None` opens the ticket directly. Use the **↑ / ↓** buttons to reorder the categories: this is the order shown in the Discord menu and buttons, and already-sent panels update automatically.
- **Sub-panels**: a sub-panel is a list of choices; each choice can lead to another sub-panel (`Next`) or open the ticket. The flow can chain as many sub-panels as needed (category → sub-panel → choice → sub-panel → …), and the ticket is only created at the end. Choices also have **↑ / ↓** buttons to change their order in the menu.
- **Import a list of choices**: in **Tickets → Sub-panels**, select a sub-panel and use **Import a list of choices**. One item per line, format `Name : price` (or `Name | price`). The price is written into the choice **description**, which is also what `{prix}` / `[prix]` uses in the ticket opening message and ticket name.
- **Price field on a choice**: each choice also has a **Price** field and a **→ description** button. If the description is empty when you save, the price is used as the description.
- **Choice stock**: click **Plus en stock** on a choice to mark it out of stock (shown as **⛔ Out of stock** in Discord and blocked when selected). Click **Remettre en stock** to restore it and automatically post the restock announcement in the channel configured in **Restock**.
- **Panels** → **Type**:
  - **Button**: a single “Open a ticket” button.
  - **Several buttons**: a banner + one button per category. Clicking a button opens the category and chains the linked sub-panels (the ticket is only created at the end of the flow).
  - **Dropdown**: a menu listing the categories.
- Already-sent panels update automatically when you change categories, color or logo.
- **📊 Stats button**: check the option to add a stats button. Its text, emoji, color and the whole stats message are configured in the **Tickets → Stats** tab (see below).
- In the **Sent panels** list:
  - **✏️ Edit** reloads the panel into the form; change the title, description, image, logo, color, footer or button, then click **Update this panel**. The existing Discord message is edited directly (no duplicate).
  - **📋 Duplicate** copies the panel into the form as a **new** panel: change a few things and click **Send the panel** to publish a new message. The original stays untouched.
  - **Delete** removes the panel (and optionally the Discord message).

### Ticket stats panel

The **📊 Stats** button shown on a ticket panel can be fully customized in **Tickets → Stats**:

- **Button**: text, emoji and color, plus the text displayed to the left of the button in a multi-button panel.
- **Message**: title, description, color, image, logo, footer and timestamp.
- **Fields**: show/hide “Tickets opened”, “Tickets currently open”, “Vouches” and “Average rating”, and rename each field.
- **Rating**: the average rating is displayed with big stars (`⭐⭐⭐⭐☆`), the exact score (`4.80 / 5`) and the number of reviews it is based on (`-# sur **24** avis`). Stars and the subtext are editable.
- **Free fields**: one `Name | Value` per line (15 maximum).

Variables available in the title, description, field names/values and footer: `{tickets}`, `{open}`, `{vouches}`, `{reviews}`, `{stars}`, `{rating}`, `{average}`, `{config}` and `{server}`. Defaults look like `📊 Statistiques — {config}` with a short live description. Already-sent panels are updated automatically when the button text changes.

### Role claim panel

The **Roles** tab configures a self-service role panel:

- **Channel**: the dedicated channel where the panel is posted.
- **Message**: title, description, image, logo, color, footer and default button color. Variables: `{server}` and `{count}` (number of roles).
- **Behavior**: clicking a button gives the role; clicking again removes it, or the panel can be set to only give the role.
- **Buttons**: one per role (25 maximum), with a custom button text, emoji and color, plus a custom text displayed next to the button in the panel. Drag order with **↑ / ↓**.

Click **Send the panel** to post it, or **Update the panel** to edit the existing message in place. Changing a role automatically refreshes the sent panel. The bot refuses a role above its own highest role or managed by an integration.

### Cross-server auto role

The **Role auto** tab gives a role on another server when a member joins the selected server:

- **Source server**: the server currently selected in the dashboard. The trigger is a member joining or rejoining it.
- **Target server**: any other server where the bot is installed. Choose it from the list.
- **Role**: the role to grant on the target server. Roles managed by an integration or placed above the bot's highest role cannot be assigned.
- **Enable**: the feature is inactive until the target server and role are chosen.

When the member is already on the target server, the role is added immediately. Otherwise, the bot keeps a **pending grant** and applies it as soon as the member joins the target server (only if they are still a member of the source server). The tab shows how many grants are pending and lets you clear them.

The bot needs the **Manage Roles** permission on the target server, and its own role must be above the role being granted. Bots are ignored.



- **Ticket channel name**: in **Tickets → Settings**, the **Ticket channel name** field defines the name given at opening. Available variables: `{user}`, `{username}`, `{displayname}`, `{category}`, `{sub}`, `{config}`, `{number}` and **`[prix]`**. Empty = “❌-category” (historical behavior). Example: `ticket-{username}` or `[prix]-{category}`.
- **Price per category**: each category has a **Price** field. The **`[prix]`** (or `{prix}`) variable is replaced by this price in the description, the ticket name and the opening message.
- **Description = price**: the **Put the price in the description** button fills the description with `[prix]`, which directly shows the category price. Then just save.
- Each category can also have its **own ticket name**, which replaces the configuration's global name.

### Vouch

- Enable the **Vouch button** in **Tickets → Settings** (a vouch channel must be configured in **Vouches**).
- The **⭐ Vouch** button appears in the ticket opening message. Only the ticket creator or the member who claimed it can use it.
- The member chooses **1 to 5 stars**, then writes a message. The vouch is published in the dedicated channel with the profile picture, rating, message and the block you defined (Service, Support, Price…).
- **Ticket logs**: in the vouch channel, the **📜 View ticket logs** button downloads the ticket transcript. It is reserved for staff (ticket staff roles, moderation roles or full access).
- **Delete a vouch**: the **🗑️ Delete vouch** button removes the vouch and its Discord message. Reserved for staff.
- From the dashboard **Vouches** page, you can also **delete any vouch** from the full list, not only the last 12.

### Closing a ticket

- **Staff** clicking **Close** gets a confirmation:
  - **Yes, sale completed** → amount / buyer / product form → sales panel updated → ticket closed.
  - **No, no sale** → ticket closed without a sale.
- **Customer** (ticket creator):
  - if the Vouch button is enabled and they have not vouched yet, the close is **blocked**. They see **Vouch now** and **Ask a staff member**.
  - **Ask a staff member** mentions the ticket role(s) so a staff member can come and close the ticket without a vouch.
  - once they have vouched (or if the Vouch button is disabled), the customer can close the ticket themselves. A customer can never register a sale.

### Member backup (server ban / migration)

The **Backup** page has a **Member backup** section:

- **💾 Save members**: stores every non-bot member with their name and roles.
- **📨 Reinvite members**: creates a permanent invite and sends it by DM to every saved member who is not already on the server.
- **Backup to use**: if the old server was banned and you restore on a **new** server, pick the old server's backup in the dropdown. The invite still points to the new server.
- When a saved member joins, their roles are restored automatically **by name** (roles that no longer exist or cannot be assigned are skipped).

Discord does not allow a bot to force-add a member: the bot can only send an invite by DM. The backup is also stored in Supabase with the rest of the server data.

## Live preview

On the right side of the dashboard, the **Live preview** reproduces the exact Discord message that will be sent:

- **Tickets → Panels**: embed, image, logo, footer, buttons, dropdown, stats button.
- **Tickets → Stats**: the full stats embed with its fields, image, logo and footer.
- **Roles**: the role claim panel with its image, logo and one button per role.
- **Tickets → Opening message**: text, embed, custom fields, claim/close buttons and the Vouch button when enabled.
- **Products / Restock**: title, description or variant table, image, logo, footer and link buttons.
- **Vouches**: review embed and the staff buttons.
- **Sales**: tracking panel.

The preview updates while you type. **Click a title, description, footer or button label** in the preview to edit it directly: the corresponding form field is updated when you press Enter or click elsewhere.
