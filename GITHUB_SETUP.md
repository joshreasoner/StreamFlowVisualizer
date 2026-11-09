# GitHub Setup Guide

Your repository is now initialized and ready to push to GitHub. Follow these steps:

## Step 1: Create a GitHub Repository

1. Go to https://github.com/new
2. Enter repository name: `StreamFlowVisualizer` (or your preferred name)
3. Choose "Public" if you want it visible to everyone
4. **Do NOT initialize with README, .gitignore, or license** (we already have these)
5. Click "Create repository"

## Step 2: Configure Your Local Repository

After creating the repo on GitHub, you'll see commands to push. Use these commands:

```bash
git remote add origin https://github.com/YOUR_USERNAME/StreamFlowVisualizer.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 3: Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** → **Pages**
3. Under "Build and deployment":
   - **Source**: Select "GitHub Actions"
   - This will automatically use the workflow we created (`.github/workflows/deploy.yml`)

## Step 4: Wait for Deployment

1. Go to your repository's **Actions** tab
2. Watch for the workflow to complete
3. Your site will be available at: `https://YOUR_USERNAME.github.io/StreamFlowVisualizer/`

## What We've Set Up

- ✅ Git repository initialized on `main` branch
- ✅ `.gitignore` configured for .NET projects (excludes build artifacts, bin/, obj/, etc.)
- ✅ GitHub Actions workflow (`.github/workflows/deploy.yml`) that:
  - Builds the .NET 10 project
  - Publishes it as a static site
  - Deploys to GitHub Pages on every push to `main`

## Important Notes

### About Your GitHub Username
Update the git configuration with your real name and email:
```bash
git config user.name "Your Name"
git config user.email "your.email@github.com"
```

### About the Application URL
Since GitHub Pages serves from `/StreamFlowVisualizer/`, you may need to update your app's base path:
- Update `appsettings.json` or use a base href in your HTML if needed
- The ASP.NET Core app should handle this automatically in most cases

### GitHub Pages Limitations
- GitHub Pages hosts **static content only**
- Your ASP.NET Core app must be fully client-side (SPA) or pre-built static HTML/JS
- If you need backend APIs, consider Azure, Heroku, or Railway instead

## Next Steps

1. Push your code to GitHub
2. Enable GitHub Pages in repository settings
3. Watch the Actions tab for the build to complete
4. Visit your GitHub Pages URL

Questions? Check out:
- https://docs.github.com/en/pages
- https://docs.github.com/en/actions
