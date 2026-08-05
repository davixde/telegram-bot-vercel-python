 <img src=".github/assets/logo.svg" width="600" align="center">

<p align="center">
  <a href="#projects">🌐 Projects</a>
  ·
  <a href="#how-to-map">🗺️ How to Map</a>
</p>

 ----

Umbrella project based on mapping public pianos (`amenity=piano`) on **OpenStreetMap**.


<br>

### 🎯 Goals
> 1. **Define Mapping Standards**
> 2. **Create Community Tools**

<br>
<br>

## 🌐 – Projects <a id="projects"></a>

### <img src="https://cdn.simpleicons.org/telegram/2CA5E0" width="20" height="20" style="vertical-align: middle; margin-right: 5px;"/> [Telegram Bot](https://t.me/Osm_piano_bot)

* 📁 *[Source code folder: `/telegram-bot`](telegram_bot)*
#### Credits & Attributions

- **StreetComplete Check Icon** (`StreetComplete quest check.svg`) by [Tobias Zwick](https://github.com/westnordost) / [StreetComplete](https://github.com/streetcomplete/StreetComplete) is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

<br>
<br>

## 🗺️ – How to Map <a id="how-to-map"></a>

To add a public piano to the map, create a new **node** in your preferred OpenStreetMap editor (JOSM, iD, or via our Telegram Bot) and apply the following tagging structure:

| Tag Key | Value | Description |
| :--- | :--- | :--- |
| **`amenity`** | `piano` | ![Mandatory](https://img.shields.io/badge/-Mandatory-red?style=flat-square) Identifies the node as a public piano. |
| **`access`** | `yes` | ![Mandatory](https://img.shields.io/badge/-Mandatory-red?style=flat-square) Explicitly public and freely open to anyone. |
| | `permissive` | Nominally private, but casual use is tolerated and unrestricted by owners. |
| | `customers` | Open to the public, but informally requires a purchase prior to use (e.g., inside a café). |
| **`musical_instrument`** | `piano` | ![Optional](https://img.shields.io/badge/-Optional-blue?style=flat-square) A "real" acoustic piano (with physical strings and hammers). |
| | `digital_piano` | An electronic/digital piano or digital keyboard. |
| | `grand_piano` | Subgroup of acoustic pianos, grand pianos have horizontal frames |
| | `pipe_organ` | Pipe organ open to the public to play |

<br>

### Supplementary & Contextual Tags

| Tag Key | Value / Example | Description|
| :--- | :--- | :--- |
| **`description:en`** | `Located on the first floor near the waiting room, next to the tracks.` | ![Recommended](https://img.shields.io/badge/-Recommended-orange?style=flat-square) A brief description of the piano or its precise location, written **strictly in English** to ensure international accessibility. |
| **`name`** | *See rule* | ![Optional](https://img.shields.io/badge/-Optional-blue?style=flat-square) **Do NOT use generic names** like *"Piano"*, *"Public Piano"*, or *"Pianoforte"*. These are redundant because `amenity=piano` already states what it is. Use this tag **only** if the piano has a specific, unique, or official name (e.g., `The Chopin Grand Station Piano`). |
| **`operator`** | `SNCF` | ![Optional](https://img.shields.io/badge/-Optional-blue?style=flat-square) The entity managing the space (e.g., the railway company in a train station). |
| **`fixme`** | `position` | ![Optional](https://img.shields.io/badge/-Optional-blue?style=flat-square) Add this if the coordinates are estimated and need on-the-ground verification. |
| **`source`** | `http://example.com` | ![Optional](https://img.shields.io/badge/-Optional-blue?style=flat-square) Link or reference to where you found the information about the piano's existence. |
| **`note`** | `https://github.com/YOUR_USERNAME/YOUR_REPO` | ![Optional](https://img.shields.io/badge/-Optional-blue?style=flat-square) Link to this repository to indicate you are following this community standard. |



<br>
<br>




----
```
TOKEN = Telegram Bot Token
```


### Webhook setup
Telegram must know your app URL before it can forward messages to Vercel. Register the webhook once with:

```bash
curl -F "url=https://your-app.vercel.app/" https://api.telegram.org/bot$TOKEN/setWebhook
```

Check the webhook status with:

```bash
curl https://api.telegram.org/bot$TOKEN/getWebhookInfo
```

### Notes
- Env names are case sensitive
- The app receives Telegram POST updates on `/` and processes them server-side
- If `/start` does not reply, verify webhook registration and check Vercel logs for errors

### Telegram Mini App
- In Telegram, invia `/start`
- Il bot risponderà con un pulsante "Apri mini app"
- Il pulsante apre una pagina Web App a `/webapp/`

### Customize WebApp URL
If you want a custom URL, set:
```
WEBAPP_URL=https://telegram-bot-vercel-python.vercel.app/webapp/
```

### "Still here" confirmations (survey date)
The **Still here** button in the piano bottom sheet updates the piano's `survey:date` tag on OpenStreetMap. The edit is performed **server-side with the bot's own OSM account**, so users don't need to log in:
```
OSM_BOT_ACCESS_TOKEN = <OSM OAuth2 access token of the bot account>
```
To get one, open the [OSM OAuth 2 client](https://www.openstreetmap.org/oauth2/applications) for the bot account and use a token from a flow with the `write_api` scope (e.g. a personal access token / client-credentials token with write permissions). The `TOKEN` env var above is the Telegram bot token and is unrelated to this.

The changeset opened by the server is tagged `bot=yes` (`created_by=Public Piano map`, with a `comment`) to comply with the [OSM automated edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_edits_code_of_conduct).

The endpoint is **authenticated with Telegram's `initData`**: the Mini App sends `X-Telegram-Init-Data` (its `tg.initData`), which Telegram signs with the bot token, and the server verifies the HMAC signature and `auth_date` freshness before touching OSM. This means only real Mini App users can trigger updates — random internet callers are rejected with 403 (the page token embedded in the HTML is not enough on its own, since it is public). Only elements tagged `amenity=piano` can be updated (anything else is refused with 403) and the written date is always today. The 150 m proximity check is enforced server-side, updates are throttled per Telegram user (best-effort rate limit), and the Telegram user id is logged on each confirmation. The `TOKEN` env var must be set for the validation to be active; without it (e.g. local dev) the check is skipped.

**Outside Telegram** the server endpoint cannot be used (there is no valid `initData`), so the button falls back to editing with the **user's own OpenStreetMap account** directly against the OSM API: the user must be logged in (Settings → Connect OSM), the edit is attributed to their account (no `bot=yes` tag), the 150 m proximity check still applies, and a per-day quota is enforced client-side.

### Web App page
The Web App page is rendered by Django at `/webapp/` and can be extended with HTML, JS, or Telegram Web App interactions.

