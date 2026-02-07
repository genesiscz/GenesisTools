# az artifacts

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage Azure Artifacts.

## Commands

| Command | Description |
|---------|-------------|
| `az artifacts universal` | Manage Universal Packages |
| `az artifacts universal download` | Download a package |
| `az artifacts universal publish` | Publish a package to a feed |

## az artifacts universal download

```bash
az artifacts universal download --feed
                                --name
                                --path
                                --version
                                [--detect {false, true}]
                                [--file-filter]
                                [--org --organization]
                                [--project]
                                [--scope {organization, project}]
```

| Parameter | Description |
|-----------|-------------|
| `--feed` | Name or ID of the feed |
| `--name, -n` | Name of the package |
| `--path` | Directory to place the package contents |
| `--version, -v` | Version of the package |
| `--file-filter` | Wildcard filter for file download |
| `--scope` | Scope of the feed: 'project' or 'organization' |

## az artifacts universal publish

```bash
az artifacts universal publish --feed
                               --name
                               --path
                               --version
                               [--description]
                               [--detect {false, true}]
                               [--org --organization]
                               [--project]
                               [--scope {organization, project}]
```

| Parameter | Description |
|-----------|-------------|
| `--feed` | Name or ID of the feed |
| `--name, -n` | Name of the package |
| `--path` | Directory containing the package contents |
| `--version, -v` | Version of the package |
| `--description, -d` | Description of the package |
| `--scope` | Scope of the feed: 'project' or 'organization' |

## Links

- [az artifacts](https://learn.microsoft.com/en-us/cli/azure/artifacts?view=azure-cli-latest)
- [az artifacts universal](https://learn.microsoft.com/en-us/cli/azure/artifacts/universal?view=azure-cli-latest)
