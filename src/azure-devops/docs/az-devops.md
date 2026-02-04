# az devops

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage Azure DevOps organization level operations.

**Related Groups:** `az pipelines`, `az boards`, `az repos`, `az artifacts`

## Commands

| Command | Description |
|---------|-------------|
| `az devops configure` | Configure the Azure DevOps CLI or view your configuration |
| `az devops invoke` | Invoke request for any DevOps area and resource |
| `az devops login` | Set the credential (PAT) to use for a particular organization |
| `az devops logout` | Clear the credential for all or a particular organization |
| `az devops admin` | Manage administration operations |
| `az devops admin banner` | Manage organization banner |
| `az devops admin banner add` | Add a new banner and immediately show it |
| `az devops admin banner list` | List banners |
| `az devops admin banner remove` | Remove a banner |
| `az devops admin banner show` | Show details for a banner |
| `az devops admin banner update` | Update the message, level, or expiration date for a banner |
| `az devops extension` | Manage extensions |
| `az devops extension disable` | Disable an extension |
| `az devops extension enable` | Enable an extension |
| `az devops extension install` | Install an extension |
| `az devops extension list` | List extensions installed in an organization |
| `az devops extension search` | Search extensions from marketplace |
| `az devops extension show` | Get detail of single extension |
| `az devops extension uninstall` | Uninstall an extension |
| `az devops project` | Manage team projects |
| `az devops project create` | Create a team project |
| `az devops project delete` | Delete team project |
| `az devops project list` | List team projects |
| `az devops project show` | Show team project |
| `az devops security group` | Manage security groups |
| `az devops security group create` | Create a new Azure DevOps group |
| `az devops security group delete` | Delete an Azure DevOps group |
| `az devops security group list` | List all the groups in a project or organization |
| `az devops security group show` | Show group details |
| `az devops security group update` | Update name AND/OR description for an Azure DevOps group |
| `az devops security group membership` | Manage memberships for security groups |
| `az devops security group membership add` | Add membership |
| `az devops security group membership list` | List memberships for a group or user |
| `az devops security group membership remove` | Remove membership |
| `az devops security permission` | Manage security permissions |
| `az devops security permission list` | List tokens for given user/group and namespace |
| `az devops security permission namespace` | Manage security namespaces |
| `az devops security permission namespace list` | List all available namespaces for an organization |
| `az devops security permission namespace show` | Show details of permissions available in each namespace |
| `az devops security permission reset` | Reset permission for given permission bit(s) |
| `az devops security permission reset-all` | Clear all permissions of this token for a user/group |
| `az devops security permission show` | Show permissions for given token, namespace and user/group |
| `az devops security permission update` | Assign allow or deny permission to given user/group |
| `az devops service-endpoint` | Manage service endpoints/connections |
| `az devops service-endpoint azurerm` | Manage Azure RM service endpoints/connections |
| `az devops service-endpoint azurerm create` | Create an Azure RM type service endpoint |
| `az devops service-endpoint create` | Create a service endpoint using configuration file |
| `az devops service-endpoint delete` | Deletes service endpoint |
| `az devops service-endpoint github` | Manage GitHub service endpoints/connections |
| `az devops service-endpoint github create` | Create a GitHub service endpoint |
| `az devops service-endpoint list` | List service endpoints in a project |
| `az devops service-endpoint show` | Get the details of a service endpoint |
| `az devops service-endpoint update` | Update a service endpoint |
| `az devops team` | Manage teams |
| `az devops team create` | Create a team |
| `az devops team delete` | Delete a team |
| `az devops team list` | List all teams in a project |
| `az devops team list-member` | List members of a team |
| `az devops team show` | Show team details |
| `az devops team update` | Update a team's name and/or description |
| `az devops user` | Manage users |
| `az devops user add` | Add user |
| `az devops user list` | List users in an organization |
| `az devops user remove` | Remove user from an organization |
| `az devops user show` | Show user details |
| `az devops user update` | Update license type for a user |
| `az devops wiki` | Manage wikis |
| `az devops wiki create` | Create a wiki |
| `az devops wiki delete` | Delete a wiki |
| `az devops wiki list` | List all the wikis in a project or organization |
| `az devops wiki show` | Show details of a wiki |
| `az devops wiki page` | Manage wiki pages |
| `az devops wiki page create` | Add a new page |
| `az devops wiki page delete` | Delete a page |
| `az devops wiki page show` | Get the content of a page or open a page |
| `az devops wiki page update` | Edit a page |

## az devops configure

```bash
az devops configure [--defaults]
                    [--list]
                    [--use-git-aliases {false, true}]
```

| Parameter | Description |
|-----------|-------------|
| `--defaults, -d` | Space separated 'name=value' pairs for common arguments defaults |
| `--list, -l` | Lists the contents of the config file |
| `--use-git-aliases` | Set to 'true' to configure Git aliases global git config file |

## az devops login

```bash
az devops login [--org --organization]
```

## az devops invoke

Invoke request for any DevOps area and resource.

```bash
az devops invoke [--accept-media-type]
                 [--api-version]
                 [--area]
                 [--detect {false, true}]
                 [--encoding {ascii, utf-16be, utf-16le, utf-8}]
                 [--http-method {DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT}]
                 [--in-file]
                 [--media-type]
                 [--org --organization]
                 [--out-file]
                 [--query-parameters]
                 [--resource]
                 [--route-parameters]
```

### Examples

Discover areas related to 'Wiki':
```bash
az devops invoke --query "[?contains(area,'wiki')]"
```

Get all wikis in a project:
```bash
az devops invoke --area wiki --resource wikis --route-parameters project={Project Name} -o json
```

## Links

- [az devops](https://learn.microsoft.com/en-us/cli/azure/devops?view=azure-cli-latest)
