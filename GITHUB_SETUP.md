# Deploy StreamFlowVisualizer to Azure

The app requires ASP.NET Core for its MVC page and API endpoints, so GitHub
Pages cannot host the complete application. The repository's GitHub Actions
workflow deploys the app to Azure App Service instead.

## 1. Create an Azure App Service

In the Azure portal, create a **Web App** with these settings:

- **Publish:** Code
- **Runtime stack:** .NET 10
- **Operating system:** Windows
- **Pricing plan:** Free (F1)
- **Name:** a globally unique name, which will be the `*.azurewebsites.net`
  hostname

Review the plan and any charges shown in the portal before creating the resource.
F1 is a shared, limited plan with no production SLA.

## 2. Add GitHub deployment settings

In the web app, download its publish profile and keep the XML private. In GitHub,
open **Settings → Secrets and variables → Actions** and add:

- Repository variable `AZURE_WEBAPP_NAME` with the web app's exact name.
- Repository secret `AZURE_WEBAPP_PUBLISH_PROFILE` with the entire publish
  profile XML.

Never commit the publish profile or paste it into source files.

## 3. Deploy

Push changes to `main`. The workflow runs the test suite and publishes the app;
on a push (not a pull request), it deploys to App Service. Follow the run in the
repository's **Actions** tab, then visit
`https://<app-name>.azurewebsites.net`.

The workflow is defined in `.github/workflows/deploy.yml`. GitHub Pages should
not be enabled as the app's hosting target: it only serves static files and
cannot run this app's ASP.NET Core controllers.
