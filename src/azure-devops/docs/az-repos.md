# az repos

> Part of the **azure-devops** extension for Azure CLI (version 2.30.0+)

Manage Azure Repos.

## Commands

| Command | Description |
|---------|-------------|
| `az repos create` | Create a Git repository in a team project |
| `az repos delete` | Delete a Git repository in a team project |
| `az repos list` | List Git repositories of a team project |
| `az repos show` | Get the details of a Git repository |
| `az repos update` | Update the Git repository |
| `az repos import` | Manage Git repositories import |
| `az repos import create` | Create a git import request |
| `az repos policy` | Manage branch policy |
| `az repos policy approver-count` | Manage approver count policy |
| `az repos policy approver-count create` | Create approver count policy |
| `az repos policy approver-count update` | Update approver count policy |
| `az repos policy build` | Manage build policy |
| `az repos policy build create` | Create build policy |
| `az repos policy build update` | Update build policy |
| `az repos policy case-enforcement` | Manage case enforcement policy |
| `az repos policy case-enforcement create` | Create case enforcement policy |
| `az repos policy case-enforcement update` | Update case enforcement policy |
| `az repos policy comment-required` | Manage comment required policy |
| `az repos policy comment-required create` | Create comment resolution required policy |
| `az repos policy comment-required update` | Update comment resolution required policy |
| `az repos policy create` | Create a policy using a configuration file |
| `az repos policy delete` | Delete a policy |
| `az repos policy file-size` | Manage file size policy |
| `az repos policy file-size create` | Create file size policy |
| `az repos policy file-size update` | Update file size policy |
| `az repos policy list` | List all policies in a project |
| `az repos policy merge-strategy` | Manage merge strategy policy |
| `az repos policy merge-strategy create` | Create merge strategy policy |
| `az repos policy merge-strategy update` | Update merge strategy policy |
| `az repos policy required-reviewer` | Manage required reviewer policy |
| `az repos policy required-reviewer create` | Create required reviewer policy |
| `az repos policy required-reviewer update` | Update required reviewer policy |
| `az repos policy show` | Show policy details |
| `az repos policy update` | Update a policy using a configuration file |
| `az repos policy work-item-linking` | Manage work item linking policy |
| `az repos policy work-item-linking create` | Create work item linking policy |
| `az repos policy work-item-linking update` | Update work item linking policy |
| `az repos pr` | Manage pull requests |
| `az repos pr checkout` | Checkout the PR source branch locally |
| `az repos pr create` | Create a pull request |
| `az repos pr list` | List pull requests |
| `az repos pr show` | Get the details of a pull request |
| `az repos pr update` | Update a pull request |
| `az repos pr policy` | Manage pull request policy |
| `az repos pr policy list` | List policies of a pull request |
| `az repos pr policy queue` | Queue an evaluation of a policy for a pull request |
| `az repos pr reviewer` | Manage pull request reviewers |
| `az repos pr reviewer add` | Add one or more reviewers to a pull request |
| `az repos pr reviewer list` | List reviewers of a pull request |
| `az repos pr reviewer remove` | Remove one or more reviewers from a pull request |
| `az repos pr set-vote` | Vote on a pull request |
| `az repos pr work-item` | Manage work items associated with pull requests |
| `az repos pr work-item add` | Link one or more work items to a pull request |
| `az repos pr work-item list` | List linked work items for a pull request |
| `az repos pr work-item remove` | Unlink one or more work items from a pull request |
| `az repos ref` | Manage Git references |
| `az repos ref create` | Create a reference |
| `az repos ref delete` | Delete a reference |
| `az repos ref list` | List the references |
| `az repos ref lock` | Lock a reference |
| `az repos ref unlock` | Unlock a reference |

## az repos create

```bash
az repos create --name
                [--detect {false, true}]
                [--open]
                [--org --organization]
                [--project]
```

## az repos list

```bash
az repos list [--detect {false, true}]
              [--org --organization]
              [--project]
```

## az repos pr create

```bash
az repos pr create [--auto-complete {false, true}]
                   [--bypass-policy {false, true}]
                   [--bypass-policy-reason]
                   [--delete-source-branch {false, true}]
                   [--description]
                   [--detect {false, true}]
                   [--draft {false, true}]
                   [--merge-commit-message]
                   [--open]
                   [--org --organization]
                   [--project]
                   [--repository]
                   [--reviewers]
                   [--source-branch]
                   [--squash {false, true}]
                   [--target-branch]
                   [--title]
                   [--transition-work-items {false, true}]
                   [--work-items]
```

## Links

- [az repos](https://learn.microsoft.com/en-us/cli/azure/repos?view=azure-cli-latest)
