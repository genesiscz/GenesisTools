# az pipelines

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage Azure Pipelines.

## Commands

| Command | Description |
|---------|-------------|
| `az pipelines create` | Create a new Azure Pipeline (YAML based) |
| `az pipelines delete` | Delete a pipeline |
| `az pipelines list` | List pipelines |
| `az pipelines run` | Queue (run) a pipeline |
| `az pipelines show` | Get the details of a pipeline |
| `az pipelines update` | Update a pipeline |
| `az pipelines agent` | Manage agents |
| `az pipelines agent list` | Get a list of agents in a pool |
| `az pipelines agent show` | Show agent details |
| `az pipelines build` | Manage builds |
| `az pipelines build cancel` | Cancels if build is running |
| `az pipelines build list` | List build results |
| `az pipelines build queue` | Request (queue) a build |
| `az pipelines build show` | Get the details of a build |
| `az pipelines build definition` | Manage build definitions |
| `az pipelines build definition list` | List build definitions |
| `az pipelines build definition show` | Get the details of a build definition |
| `az pipelines build tag` | Manage build tags |
| `az pipelines build tag add` | Add tag(s) for a build |
| `az pipelines build tag delete` | Delete a build tag |
| `az pipelines build tag list` | Get tags for a build |
| `az pipelines folder` | Manage folders for organizing pipelines |
| `az pipelines folder create` | Create a folder |
| `az pipelines folder delete` | Delete a folder |
| `az pipelines folder list` | List all folders |
| `az pipelines folder update` | Update a folder name or description |
| `az pipelines pool` | Manage agent pools |
| `az pipelines pool list` | List agent pools |
| `az pipelines pool show` | Show agent pool details |
| `az pipelines queue` | Manage agent queues |
| `az pipelines queue list` | List agent queues |
| `az pipelines queue show` | Show details of agent queue |
| `az pipelines release` | Manage releases |
| `az pipelines release create` | Request (create) a release |
| `az pipelines release list` | List release results |
| `az pipelines release show` | Get the details of a release |
| `az pipelines release definition` | Manage release definitions |
| `az pipelines release definition list` | List release definitions |
| `az pipelines release definition show` | Get the details of a release definition |
| `az pipelines runs` | Manage pipeline runs |
| `az pipelines runs list` | List the pipeline runs in a project |
| `az pipelines runs show` | Show details of a pipeline run |
| `az pipelines runs artifact` | Manage pipeline run artifacts |
| `az pipelines runs artifact download` | Download a pipeline artifact |
| `az pipelines runs artifact list` | List artifacts associated with a run |
| `az pipelines runs artifact upload` | Upload a pipeline artifact |
| `az pipelines runs tag` | Manage pipeline run tags |
| `az pipelines runs tag add` | Add tag(s) for a pipeline run |
| `az pipelines runs tag delete` | Delete a pipeline run tag |
| `az pipelines runs tag list` | Get tags for a pipeline run |
| `az pipelines variable` | Manage pipeline variables |
| `az pipelines variable create` | Add a variable to a pipeline |
| `az pipelines variable delete` | Delete a variable from pipeline |
| `az pipelines variable list` | List the variables in a pipeline |
| `az pipelines variable update` | Update a variable in a pipeline |
| `az pipelines variable-group` | Manage variable groups |
| `az pipelines variable-group create` | Create a variable group |
| `az pipelines variable-group delete` | Delete a variable group |
| `az pipelines variable-group list` | List variable groups |
| `az pipelines variable-group show` | Show variable group details |
| `az pipelines variable-group update` | Update a variable group |
| `az pipelines variable-group variable` | Manage variables in a variable group |
| `az pipelines variable-group variable create` | Add a variable to a variable group |
| `az pipelines variable-group variable delete` | Delete a variable from variable group |
| `az pipelines variable-group variable list` | List the variables in a variable group |
| `az pipelines variable-group variable update` | Update a variable in a variable group |

## az pipelines create

```bash
az pipelines create --name
                    [--branch]
                    [--description]
                    [--detect {false, true}]
                    [--folder-path]
                    [--org --organization]
                    [--project]
                    [--queue-id]
                    [--repository]
                    [--repository-type {github, tfsgit}]
                    [--service-connection]
                    [--skip-first-run --skip-run {false, true}]
                    [--yaml-path --yml-path]
```

### Examples

Create from local checkout:
```bash
az pipelines create --name 'ContosoBuild' --description 'Pipeline for contoso project'
```

Create for GitHub repository:
```bash
az pipelines create --name 'ContosoBuild' --description 'Pipeline for contoso project' \
  --repository https://github.com/SampleOrg/SampleRepo --branch master
```

Create for Azure Repos:
```bash
az pipelines create --name 'ContosoBuild' --description 'Pipeline for contoso project' \
  --repository SampleRepoName --branch master --repository-type tfsgit
```

## az pipelines run

```bash
az pipelines run [--branch]
                 [--commit-id]
                 [--detect {false, true}]
                 [--folder-path]
                 [--id]
                 [--name]
                 [--open]
                 [--org --organization]
                 [--parameters]
                 [--project]
                 [--variables]
```

| Parameter | Description |
|-----------|-------------|
| `--branch` | Name of the branch on which the pipeline run is to be queued |
| `--commit-id` | Commit-id on which the pipeline run is to be queued |
| `--id` | ID of the pipeline to queue |
| `--name` | Name of the pipeline to queue |
| `--parameters` | Space separated "name=value" pairs for the parameters |
| `--variables` | Space separated "name=value" pairs for the variables |

## az pipelines list

```bash
az pipelines list [--detect {false, true}]
                  [--folder-path]
                  [--name]
                  [--org --organization]
                  [--project]
                  [--query-order {ModifiedAsc, ModifiedDesc, NameAsc, NameDesc, None}]
                  [--repository]
                  [--repository-type {bitbucket, git, github, githubenterprise, svn, tfsgit, tfsversioncontrol}]
                  [--top]
```

## Links

- [az pipelines](https://learn.microsoft.com/en-us/cli/azure/pipelines?view=azure-cli-latest)
