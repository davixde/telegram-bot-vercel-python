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

### Web App page
The Web App page is rendered by Django at `/webapp/` and can be extended with HTML, JS, or Telegram Web App interactions.

