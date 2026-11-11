# Azure deployment setup

The app is not yet deployed to Azure. The GitHub Actions workflow is configured
to deploy to Azure App Service after an Azure Web App and GitHub deployment
settings are created.

Follow [GITHUB_SETUP.md](./GITHUB_SETUP.md) to create a Free (F1) Windows Web App
running .NET 10, add the app name and publish profile to the repository's
Actions settings, and trigger the first deployment by pushing to `main`.

The previous GitHub Pages workflow only published static files and could not
host the full ASP.NET Core application.
