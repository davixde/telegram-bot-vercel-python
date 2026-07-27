### 1. Run the Local Server
You have two options to run the project locally on port `3000`:

#### Option A: Using Django's Development Server (Recommended)
Run the following command to start Django directly on port `3000`:
```bash
source .venv/bin/activate
python manage.py runserver 3000
```

#### Option B: Using Vercel CLI (Replicates Production Environment)
1. You must have uv installed
```bash
brew install uv
```

2. If you have Vercel CLI installed, you can emulate the serverless environment with:
```bash
vercel dev --listen 3000
```
*(Or use `npx vercel dev --listen 3000` if you want to run it via npm without installing globally).*

## 2. Kill the local server
```bash
lsof -ti :3000 | xargs kill -9
pkill -f "manage.py runserver"
pkill -f "vercel dev"
```