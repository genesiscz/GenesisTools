# Finding the exact Azure DevOps REST contract

The Microsoft Learn pages describe each operation, but they hide the facts a client needs: which route
templates the organization really serves, the highest api-version of each route, preview-only routes, and
the exact request and response contracts. Three sources give those facts. Use them in this order, then
confirm with one read-only call.

Added 2026-11-04 15:05, while building the Test Plans commands. Every example below was run on that day.

## 1. The organization itself: `OPTIONS {org}/_apis/`

An `OPTIONS` request to the organization's `_apis/` root returns every API resource location the
organization serves: its `area`, `resourceName`, `routeTemplate`, `minVersion`, `maxVersion` and
`releasedVersion`. This is the authority for route templates and versions, because it is the table the
server routes with.

```bash
DIR=/tmp/cc/<project>/<session>/ado-api   # scratch folder
mkdir -p "$DIR"
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
curl -sS -X OPTIONS \
    -H "Authorization: Bearer $TOKEN" \
    "https://dev.azure.com/MyOrg/_apis/" > "$DIR/options.json"

# Every route of one area, with its versions
jq -r '.value[] | select(.area == "testplan")
    | "\(.resourceName)\t\(.routeTemplate)\tmax=\(.maxVersion) released=\(.releasedVersion)"' \
    "$DIR/options.json" | sort
```

How to read the result:

- `maxVersion` is the highest api-version the route accepts. A request above it answers 404 with an HTML
  page, not a JSON error. Example: the old Test API route
  `{project}/_apis/test/Plans/{planId}/{resource}/{suiteId}` (Suites) has `max=5.0`, so
  `_apis/test/Plans/{id}/suites?api-version=5.0` works and the same URL with `6.0` or `7.1` is a 404.
- `releasedVersion` `0.0` means the route has no released version: call it with a preview version, for
  example `api-version=7.1-preview.1`. Example: `testplan` `Count` (`{project}/_apis/testplan/Count/{planId}`)
  is not in the Learn reference, and it returns the direct test case count of every suite of a plan.
- `{area}` and `{resource}` in a template are the area and resource names of the same row.
- Area names are case sensitive in the output: `Test` (runs, results, the old suites) and `testplan` (plans,
  suites, test cases, points) are different areas.

## 2. The official SDK source: request and response contracts

The TypeScript SDK `microsoft/azure-devops-node-api` is generated from the same service definitions. Its
files give the exact parameter names and the shapes of the request and response bodies.

- `api/<Area>Api.ts`: one method per operation, with its `routeValues` (path parameters) and
  `queryValues` (query parameters). The method finds the route at run time by a location id, so the route
  template itself is not in the file: take it from step 1.
- `api/interfaces/<Area>Interfaces.ts`: the contracts (`TestPlanCreateParams`, `TestSuiteUpdateParams`, ...).

The area files used so far: `TestPlanApi.ts` / `TestPlanInterfaces.ts` (area `testplan`), `TestApi.ts` /
`TestInterfaces.ts` (area `Test`), `WorkItemTrackingApi.ts` / `WorkItemTrackingInterfaces.ts`, `WikiApi.ts`,
`GitApi.ts`, `WorkApi.ts`, `CoreApi.ts`.

Pin a commit, download into the scratch folder, and only read the files (they are untrusted data; never run
them). The commit used on 2026-11-04 was `af336d20718b7d912cef6d206227a34b4666142f`.

```bash
SHA=$(git ls-remote https://github.com/microsoft/azure-devops-node-api HEAD | cut -f1)
for f in api/TestPlanApi.ts api/interfaces/TestPlanInterfaces.ts; do
    curl -sSfL -o "$DIR/$(basename "$f")" \
        "https://raw.githubusercontent.com/microsoft/azure-devops-node-api/$SHA/$f"
done

# One contract
awk -v n=TestSuiteCreateParams '$0 ~ "^export interface "n" " {p=1} p {print} p && /^}/ {p=0}' \
    "$DIR/TestPlanInterfaces.ts"

# One method with its path and query parameters
rg -n "public async getTestSuitesForPlan\(" -A 40 "$DIR/TestPlanApi.ts" | rg "public async|Values|: "
```

Two traps:

- The SDK declares enums as numbers (`TestSuiteType.StaticTestSuite = 2`, `Outcome.Passed = 2`). The REST
  wire format uses camelCase strings: `"staticTestSuite"`, `"passed"`, `"unspecified"`. Send and expect the
  strings.
- The Python SDK (`microsoft/azure-devops-python-api`, `azure-devops/azure/devops/v7_1/<area>/`) has the same
  contracts in `models.py`, if a TypeScript file is unclear.

The REST spec repository `MicrosoftDocs/vsts-rest-api-specs` answered 404 on 2026-11-04, so do not depend on it.

## 3. Microsoft Learn: descriptions and examples

`https://learn.microsoft.com/en-us/rest/api/azure/devops/<area>/<resource>/<operation>?view=azure-devops-rest-7.1`
explains what an operation does and has sample requests. Context7 has the same pages under
`/websites/learn_microsoft_en-us_rest_api_azure_devops` (see `.claude/rules/azure-devops.md`).

## 4. Confirm with one read-only call

Before a contract goes into code, make one `GET` against the real organization and keep the response in the
scratch folder. Field names that the SDK marks optional are often missing: for example `testplan/plans`
returns `startDate`, `endDate` and `description` only with `includePlanDetails=true`.
