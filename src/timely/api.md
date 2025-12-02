Welcome! This document provides a full list of all Timely APIs currently available, so you can start integrating Timely with your favorite applications.

Got questions? Please send them to support@timelyapp.com.

Authentication
--------------

OAuth2 Authentication: http://tools.ietf.org/html/rfc6749

Create an OAuth Application (only available to the Admin User): https://app.timelyapp.com/:account_id/oauth_applications

Enter your application name and the redirect_url to your application.

Acquire the Application Id and Secret.

> The base URL for all API's is: https://api.timelyapp.com/1.1

OAuth Code
----------

```
Example Request: (try this in your web browser)
https://api.timelyapp.com/1.1/oauth/authorize?response_type=code
&redirect_uri=your_redirect_uri&client_id=your_client_id
```

Users are redirected to request their Timely identity.

### HTTP Request

`GET /oauth/authorize`

### Compulsory Parameters

| Parameter | Description |
| --- | --- |
| response_type | code |
| redirect_uri | http://your-redirect-url/ |
| client_id | your_application_id |

If the user accepts your request, Timely will redirect back with the code parameter, which you need to use to get the token.

OAuth Token
-----------

```
Example Request:
curl -X POST --data "redirect_uri=https://your-redirect_url/&code=your_response_code
&client_id=application_id&client_secret=application_secret&grant_type=authorization_code"
https://api.timelyapp.com/1.1/oauth/token
```

```
{
  "access_token":"1886f011cd72eabc88d087eabd741b51a9059f5ba57c7bc439285fe86a4e465a",
  "token_type":"bearer",
  "refresh_token":"9db4d1a5d87c707b8125d8f93ad08091fb3ff8b93be901dbeaba968cf532ed9b"
}
```

```
200 OK
```

Users are redirected to request their Timely identity.

### HTTP Request

`POST /oauth/token`

### Compulsory Parameters

| Parameter | Description |
| --- | --- |
| redirect_uri | http://your-redirect-url/ |
| code | your_response_code |
| client_id | your_application_id |
| client_secret | your_application_secret |
| grant_type | authorization_code |

The response will be a token with a refresh token. Use the token to use the following API.

Use Timely API to integrate with your apps

Timely API helps you integrate your application with Timely. Following are the list of API’s available. For any help or support email support@timelyapp.com

Accounts
--------

List all accounts
-----------------

Returns all the accounts created against one email address.

### Request

```
curl -g "https://api.timelyapp.com/1.1/accounts" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer Wi46-7cjIusNGf8kp28CzpXE_1tMkElw9RdwC7rjZNM" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/accounts`

```
GET /1.1/accounts
Accept: application/json
Content-Type: application/json
Authorization: Bearer Wi46-7cjIusNGf8kp28CzpXE_1tMkElw9RdwC7rjZNM
```

#### Parameters

None known.

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 1834,
    "name": "Timely",
    "color": "44505e",
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "logo": {
      "large_retina": "/assets/account_thumbs/account_large_retina-8bc212c450af14b3a0ea49098cdddbe4f90d5eb5fc57adfeade6ac1ad8fb1d4a.png",
      "medium_retina": "/assets/account_thumbs/account_medium_retina-10dfbcc6733ccba1d485971f63c5eb7f9b7ed1a942a0ebd140e292bcb1e4dbea.png",
      "small_retina": "/assets/account_thumbs/account_small_retina-ea5df153b4cd96fc801e2361afc7d1b06d7b95ce5c358250b81149e1a20689df.png",
      "brand_logo": false
    },
    "from": "Web",
    "max_users": 0,
    "seats": 1,
    "max_projects": 0,
    "plan_id": 1834,
    "plan_name": "Essential",
    "next_charge": "2025-08-03",
    "start_of_week": 0,
    "created_at": 1751518010,
    "payment_mode": "web",
    "paid": true,
    "company_size": "10-49",
    "plan_code": "essential",
    "plan_custom": false,
    "appstore_transaction_id": null,
    "owner_id": 4717,
    "weekly_user_capacity": 40.0,
    "default_work_days": "MON,TUE,WED,THU,FRI",
    "default_hour_rate": 0.0,
    "support_email": "support@timelyapp.com",
    "estimated_company_size": null,
    "industry": null,
    "memory_retention_days": 0,
    "tic_force_enable": false,
    "num_users": 1,
    "num_projects": 0,
    "active_projects_count": 0,
    "total_projects_count": 0,
    "capacity": {
      "hours": 40,
      "minutes": 0,
      "seconds": 0.0,
      "formatted": "40:00",
      "total_hours": 40.0,
      "total_seconds": 144000.0,
      "total_minutes": 2400.0
    },
    "status": "active",
    "beta": false,
    "azure_ad_enabled": true,
    "expired": false,
    "trial": false,
    "days_to_end_trial": 0,
    "features": [
      {
        "name": "api_access",
        "days": -1
      },
      {
        "name": "control",
        "days": -1
      },
      {
        "name": "memories",
        "days": -1
      },
      {
        "name": "billing",
        "days": -1
      },
      {
        "name": "project_required_fields",
        "days": -1
      },
      {
        "name": "teams",
        "days": -1
      },
      {
        "name": "recurring_budget",
        "days": -1
      },
      {
        "name": "notifications_project_budget",
        "days": -1
      },
      {
        "name": "weekly_user_capacity",
        "days": -1
      },
      {
        "name": "company_view",
        "days": -1
      },
      {
        "name": "anomalies",
        "days": -1
      },
      {
        "name": "log_hours_for_others",
        "days": -1
      },
      {
        "name": "project_budget",
        "days": -1
      },
      {
        "name": "budgets_hourly_rates",
        "days": -1
      },
      {
        "name": "account_branding",
        "days": -1
      },
      {
        "name": "team_lead",
        "days": -1
      },
      {
        "name": "ai_timesheet_creation",
        "days": -1
      },
      {
        "name": "in_app_support",
        "days": -1
      },
      {
        "name": "people_dashboard",
        "days": -1
      },
      {
        "name": "people_notify",
        "days": -1
      },
      {
        "name": "premium_integrations",
        "days": -1
      },
      {
        "name": "individual_capacity",
        "days": -1
      },
      {
        "name": "audits",
        "days": -1
      },
      {
        "name": "project_dashboard",
        "days": -1
      },
      {
        "name": "high_level_reports",
        "days": -1
      },
      {
        "name": "live_reports",
        "days": -1
      },
      {
        "name": "invoices",
        "days": -1
      },
      {
        "name": "planned_entries",
        "days": -1
      },
      {
        "name": "internal_costs",
        "days": -1
      },
      {
        "name": "memory_retention",
        "days": -1
      },
      {
        "name": "custom_project_currencies",
        "days": -1
      },
      {
        "name": "capacity_reports",
        "days": -1
      },
      {
        "name": "day_locking",
        "days": -1
      },
      {
        "name": "user_custom_properties",
        "days": -1
      },
      {
        "name": "tasks",
        "days": -1
      },
      {
        "name": "planning",
        "days": -1
      },
      {
        "name": "batch_log_planned_time",
        "days": -1
      },
      {
        "name": "ai_labels_suggestions",
        "days": -1
      },
      {
        "name": "integration_monday",
        "days": -1
      },
      {
        "name": "hour_states",
        "days": -1
      },
      {
        "name": "tic_integrations",
        "days": -1
      },
      {
        "name": "tic_support",
        "days": -1
      },
      {
        "name": "import_manager",
        "days": -1
      },
      {
        "name": "user_project_distribution",
        "days": -1
      }
    ]
  }
]
```

Retrieve activities
-------------------

This endpoint shows you all activities tied to you and/or any other users you have permission to view. Activities include: logged hours, created a report, shared a report.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1832/activities" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 7ddTQhAxInHLy0l0GK4WITPMIHu6lRsj07B747sSifQ" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/activities`

```
GET /1.1/1832/activities
Accept: application/json
Content-Type: application/json
Authorization: Bearer 7ddTQhAxInHLy0l0GK4WITPMIHu6lRsj07B747sSifQ
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The ID of the account you want to retrieve |
| limit | Retrieve a limited number of activities |
| offset | Retrieve activities from offset |
| order | Sorting order on created_at |
| filter | Filter activities by entity_type - Ex: filter=projects |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 177,
    "user": {
      "id": 4712,
      "email": "marijavkklyxft@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:46:50+02:00"
    },
    "message": "archived",
    "activity_type": "archive_project",
    "url": "http://app.timelyapp.local:3002/1832/projects/1897?type=archived_project",
    "updated_at": "2025-06-26T06:46:50+02:00",
    "detail": null,
    "associated_ids": [],
    "entity_type": "Project",
    "entity_deleted": false,
    "parent_entity_name": "",
    "entity": {
      "id": 1897,
      "active": true,
      "name": "Timely",
      "color": "67a3bc",
      "client": {
        "id": 1352,
        "name": "Sapiente ut quam ex.",
        "color": "e57373",
        "active": true,
        "external_id": null,
        "updated_at": "2025-07-03T06:46:50+02:00"
      },
      "updated_at": "2025-07-03T06:46:50+02:00"
    },
    "anomaly": false
  },
  {
    "id": 176,
    "user": {
      "id": 4712,
      "email": "marijavkklyxft@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/3f6267720ee843394f610f9a36fd1e2e?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:46:50+02:00"
    },
    "message": "50% of budget used",
    "activity_type": "project_budget_progress_fifty",
    "url": "http://app.timelyapp.local:3002/1832/projects/1897?type=budget_progress",
    "updated_at": "2025-07-03T06:46:50+02:00",
    "detail": null,
    "associated_ids": [],
    "entity_type": "Project",
    "entity_deleted": false,
    "parent_entity_name": "",
    "entity": {
      "id": 1897,
      "active": true,
      "name": "Timely",
      "color": "67a3bc",
      "client": {
        "id": 1352,
        "name": "Sapiente ut quam ex.",
        "color": "e57373",
        "active": true,
        "external_id": null,
        "updated_at": "2025-07-03T06:46:50+02:00"
      },
      "updated_at": "2025-07-03T06:46:50+02:00"
    },
    "anomaly": false
  }
]
```

Retrieve an account
-------------------

Returns one account object related to one company and one subscription plan.

### Request

```
curl -g "https://api.timelyapp.com/1.1/accounts/1833" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 0kxc4qEE01djrMZU09NSNM3ik3ySvd1YHwPz1jQESLY" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/accounts/:id`

```
GET /1.1/accounts/1833
Accept: application/json
Content-Type: application/json
Authorization: Bearer 0kxc4qEE01djrMZU09NSNM3ik3ySvd1YHwPz1jQESLY
```

#### Parameters

| Name | Description |
| --- | --- |
| id | The id of the account to be retrieved |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 1833,
  "name": "Timely",
  "color": "44505e",
  "currency": {
    "id": "usd",
    "name": "United States Dollar",
    "iso_code": "USD",
    "symbol": "$",
    "symbol_first": true
  },
  "logo": {
    "large_retina": "/assets/account_thumbs/account_large_retina-8bc212c450af14b3a0ea49098cdddbe4f90d5eb5fc57adfeade6ac1ad8fb1d4a.png",
    "medium_retina": "/assets/account_thumbs/account_medium_retina-10dfbcc6733ccba1d485971f63c5eb7f9b7ed1a942a0ebd140e292bcb1e4dbea.png",
    "small_retina": "/assets/account_thumbs/account_small_retina-ea5df153b4cd96fc801e2361afc7d1b06d7b95ce5c358250b81149e1a20689df.png",
    "brand_logo": false
  },
  "from": "Web",
  "max_users": 0,
  "seats": 1,
  "max_projects": 0,
  "plan_id": 1833,
  "plan_name": "Essential",
  "next_charge": "2025-08-03",
  "start_of_week": 0,
  "created_at": 1751518010,
  "payment_mode": "web",
  "paid": true,
  "company_size": "10-49",
  "plan_code": "essential",
  "plan_custom": false,
  "appstore_transaction_id": null,
  "owner_id": 4715,
  "weekly_user_capacity": 40.0,
  "default_work_days": "MON,TUE,WED,THU,FRI",
  "default_hour_rate": 0.0,
  "support_email": "support@timelyapp.com",
  "estimated_company_size": null,
  "industry": null,
  "memory_retention_days": 0,
  "tic_force_enable": false,
  "num_users": 1,
  "num_projects": 0,
  "active_projects_count": 0,
  "total_projects_count": 0,
  "capacity": {
    "hours": 40,
    "minutes": 0,
    "seconds": 0.0,
    "formatted": "40:00",
    "total_hours": 40.0,
    "total_seconds": 144000.0,
    "total_minutes": 2400.0
  },
  "status": "active",
  "beta": false,
  "azure_ad_enabled": true,
  "expired": false,
  "trial": false,
  "days_to_end_trial": 0,
  "features": [
    {
      "name": "api_access",
      "days": -1
    },
    {
      "name": "control",
      "days": -1
    },
    {
      "name": "memories",
      "days": -1
    },
    {
      "name": "billing",
      "days": -1
    },
    {
      "name": "project_required_fields",
      "days": -1
    },
    {
      "name": "teams",
      "days": -1
    },
    {
      "name": "recurring_budget",
      "days": -1
    },
    {
      "name": "notifications_project_budget",
      "days": -1
    },
    {
      "name": "weekly_user_capacity",
      "days": -1
    },
    {
      "name": "company_view",
      "days": -1
    },
    {
      "name": "anomalies",
      "days": -1
    },
    {
      "name": "log_hours_for_others",
      "days": -1
    },
    {
      "name": "project_budget",
      "days": -1
    },
    {
      "name": "budgets_hourly_rates",
      "days": -1
    },
    {
      "name": "account_branding",
      "days": -1
    },
    {
      "name": "team_lead",
      "days": -1
    },
    {
      "name": "ai_timesheet_creation",
      "days": -1
    },
    {
      "name": "in_app_support",
      "days": -1
    },
    {
      "name": "people_dashboard",
      "days": -1
    },
    {
      "name": "people_notify",
      "days": -1
    },
    {
      "name": "premium_integrations",
      "days": -1
    },
    {
      "name": "individual_capacity",
      "days": -1
    },
    {
      "name": "audits",
      "days": -1
    },
    {
      "name": "project_dashboard",
      "days": -1
    },
    {
      "name": "high_level_reports",
      "days": -1
    },
    {
      "name": "live_reports",
      "days": -1
    },
    {
      "name": "invoices",
      "days": -1
    },
    {
      "name": "planned_entries",
      "days": -1
    },
    {
      "name": "internal_costs",
      "days": -1
    },
    {
      "name": "memory_retention",
      "days": -1
    },
    {
      "name": "custom_project_currencies",
      "days": -1
    },
    {
      "name": "capacity_reports",
      "days": -1
    },
    {
      "name": "day_locking",
      "days": -1
    },
    {
      "name": "user_custom_properties",
      "days": -1
    },
    {
      "name": "tasks",
      "days": -1
    },
    {
      "name": "planning",
      "days": -1
    },
    {
      "name": "batch_log_planned_time",
      "days": -1
    },
    {
      "name": "ai_labels_suggestions",
      "days": -1
    },
    {
      "name": "integration_monday",
      "days": -1
    },
    {
      "name": "hour_states",
      "days": -1
    },
    {
      "name": "tic_integrations",
      "days": -1
    },
    {
      "name": "tic_support",
      "days": -1
    },
    {
      "name": "import_manager",
      "days": -1
    },
    {
      "name": "user_project_distribution",
      "days": -1
    }
  ]
}
```

Clients
-------

Clients are the companies that you work for. An account can have multiple clients.

Create a client
---------------

This API lets you create a client for an account.

### Request

```
curl "https://api.timelyapp.com/1.1/1852/clients" -d '{"client":{"name":"Uniq name","active":true,"color":"1976d2","external_id":null}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer Mp3nvsvCpdIXtfCfm1tLYq5MGBA1rm1YBnAq9DnVnfE" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/clients`

```
POST /1.1/1852/clients
Accept: application/json
Content-Type: application/json
Authorization: Bearer Mp3nvsvCpdIXtfCfm1tLYq5MGBA1rm1YBnAq9DnVnfE
```

#### Parameters

```
{"client":{"name":"Uniq name","active":true,"color":"1976d2","external_id":null}}
```

| Name | Description |
| --- | --- |
| client _required_ | Client attributes |
| client[name] _required_ | Specifies the client name |
| client[active] | Example values: "true" or "false". Using "false" changes the client state to "archived" |
| client[external_id] | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| client[color] | Specifies the client color. Example values: 1976d2, 00796b, 2e7d32, d4e157, ffeb3b, ffb74d, ff8a65, e57373, b72367, 7e57c2 (when omitted, a random color will be used) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 1368,
  "name": "Uniq name",
  "color": "1976d2",
  "active": true,
  "external_id": null,
  "updated_at": "2025-07-03T06:46:55+02:00"
}
```

List all clients
----------------

NOTE: By default, client list will return first 10000 clients in alphabetical order. You can also use optional parameters like “limit”, “offset”, “show” and “order” to change the results.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1853/clients" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 8_wMxgZgHpPMjM1EXweYqYogcNP_cH4luqGhUIXA4NE" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/clients`

```
GET /1.1/1853/clients
Accept: application/json
Content-Type: application/json
Authorization: Bearer 8_wMxgZgHpPMjM1EXweYqYogcNP_cH4luqGhUIXA4NE
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | Account ID for the clients you want to retrieve |
| limit | Retrieve number of clients |
| offset | Retrieve clients from offset |
| order | "asc (default)" and "desc" |
| show | Specifies which records to retrieve. The default shows a current account’s active clients (show=active). Example: "show=all" or "show=active" or "show=archived" |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 1369,
    "name": "Consectetur dolores aut perferendis.",
    "color": "ffeb3b",
    "active": true,
    "external_id": null,
    "updated_at": "2025-07-03T06:46:55+02:00",
    "external_references": []
  }
]
```

Show client
-----------

### Request

```
curl -g "https://api.timelyapp.com/1.1/1855/clients/1371" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer hryMNpUE1VzKM18GGhemMZLNxyIdq09pZY3Sc0RiyM0" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/clients/:id`

```
GET /1.1/1855/clients/1371
Accept: application/json
Content-Type: application/json
Authorization: Bearer hryMNpUE1VzKM18GGhemMZLNxyIdq09pZY3Sc0RiyM0
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | Account ID for the client you want to retrieve |
| id | Client ID to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 1371,
  "name": "Possimus quaerat saepe quis.",
  "color": "b72367",
  "active": true,
  "external_id": null,
  "updated_at": "2025-07-03T06:46:56+02:00",
  "external_references": []
}
```

Update a client
---------------

Update client details just by using a client's ID.

### Request

```
curl "https://api.timelyapp.com/1.1/1857/clients/1373" -d '{"client":{"name":"Updated name","active":true}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer PQqWR6IGy5v9wMVdFJhrvaszGEFZdhjgk9aIAR4Rb_Y" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/clients/:id`

```
PUT /1.1/1857/clients/1373
Accept: application/json
Content-Type: application/json
Authorization: Bearer PQqWR6IGy5v9wMVdFJhrvaszGEFZdhjgk9aIAR4Rb_Y
```

#### Parameters

```
{"client":{"name":"Updated name","active":true}}
```

| Name | Description |
| --- | --- |
| id _required_ | Client ID |
| client _required_ | Client attributes |
| client[name] _required_ | Specifies the client name |
| client[active] | Example values: "true" or "false". Using "false" changes the client state to "archived" |
| client[external_id] | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| client[color] | Specifies the client color. Example values: 1976d2, 00796b, 2e7d32, d4e157, ffeb3b, ffb74d, ff8a65, e57373, b72367, 7e57c2 (when omitted, the current client color will be used) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 1373,
  "name": "Updated name",
  "color": "ffb74d",
  "active": true,
  "external_id": null,
  "updated_at": "2025-07-03T06:46:56+02:00"
}
```

Day locking (Locked Time)
-------------------------

Locked Time helps prevent accidental changes or unauthorized edits, making your time records more trustworthy and dependable. This feature offers you a peace of mind by allowing control over which days, weeks, or months to lock or unlock.

Create a Day locking
--------------------

This API allow you to lock days for an user.

### Request

```
curl "https://api.timelyapp.com/1.1/1858/day_properties" -d '{"day_property":{"user_ids":[4770],"dates":["2025-07-03","2025-07-04"],"locked":true}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer H18VfSPC6Wv5CdXppWhqsAm725429VPR6E8iLtEJm2s" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/day_properties`

```
POST /1.1/1858/day_properties
Accept: application/json
Content-Type: application/json
Authorization: Bearer H18VfSPC6Wv5CdXppWhqsAm725429VPR6E8iLtEJm2s
```

#### Parameters

```
{"day_property":{"user_ids":[4770],"dates":["2025-07-03","2025-07-04"],"locked":true}}
```

| Name | Description |
| --- | --- |
| user_ids _required_ | Specifies the users for which you want lock days. Numerical user IDs should separated by a comma, like so: "user_ids": "175551,117861" |
| dates _required_ | Specifies the dates to lock, should separated by a comma. Example: dates="2024-08-24, 2024-08-23" |
| locked | Example values: "true" or "false". Using "false" unlocks the days" |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
[
  {
    "id": 31,
    "user_id": 4770,
    "account_id": 1858,
    "date": "2025-07-03",
    "locked": true,
    "updated_at": 1751518017,
    "created_at": 1751518017
  },
  {
    "id": 32,
    "user_id": 4770,
    "account_id": 1858,
    "date": "2025-07-04",
    "locked": true,
    "updated_at": 1751518017,
    "created_at": 1751518017
  }
]
```

List all locked dates
---------------------

Note: 1. If “since” and “until” parameters are not passed, the period will default to the current week.

2. If the “user_ids” parameters is not passed, the default will be current user's manageable users.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1859/day_properties" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer XuHAd42V0lZg7qX6o_SZsdJ4ZJ5hw15kN_vHDNwYpKo" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/day_properties`

```
GET /1.1/1859/day_properties
Accept: application/json
Content-Type: application/json
Authorization: Bearer XuHAd42V0lZg7qX6o_SZsdJ4ZJ5hw15kN_vHDNwYpKo
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the locked dates you want to retrieve |
| since | Specifies the start date for returned results. Example: since=2014-08-18 |
| until | Specifies the end date for returned results. Example: upto=2014-08-24 |
| dates | Specifies the dates for returned results, should separated by a comma. Example: dates="2024-08-24, 2024-08-23" |
| user_ids | Specifies the users for which you want results. Numerical user IDs should separated by a comma, like so: "user_ids": "175551,117861" |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 33,
    "user_id": 4772,
    "account_id": 1859,
    "date": "2025-07-03",
    "locked": true,
    "updated_at": 1751518017,
    "created_at": 1751518017
  },
  {
    "id": 34,
    "user_id": 4772,
    "account_id": 1859,
    "date": "2025-07-04",
    "locked": true,
    "updated_at": 1751518017,
    "created_at": 1751518017
  }
]
```

Update Day locking
------------------

Update locked time by user_ids OR dates.

### Request

```
curl "https://api.timelyapp.com/1.1/1860/day_properties" -d '{"day_property":{"user_ids":[4774],"dates":["2025-07-03","2025-07-04"],"locked":false}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer W9wsqHPUccvIeECFQPa6zXEfnBTqY04Tl8ypHcZh8l8" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/day_properties`

```
PUT /1.1/1860/day_properties
Accept: application/json
Content-Type: application/json
Authorization: Bearer W9wsqHPUccvIeECFQPa6zXEfnBTqY04Tl8ypHcZh8l8
```

#### Parameters

```
{"day_property":{"user_ids":[4774],"dates":["2025-07-03","2025-07-04"],"locked":false}}
```

| Name | Description |
| --- | --- |
| user_ids _required_ | Specifies the users for which you want lock days. Numerical user IDs should separated by a comma, like so: "user_ids": "175551,117861" |
| dates _required_ | Specifies the dates to lock, should separated by a comma. Example: dates="2024-08-24, 2024-08-23" |
| locked | Example values: "true" or "false". Using "false" unlocks the days" |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 35,
    "user_id": 4774,
    "account_id": 1860,
    "date": "2025-07-03",
    "locked": false,
    "updated_at": 1751518017,
    "created_at": 1751518017
  },
  {
    "id": 36,
    "user_id": 4774,
    "account_id": 1860,
    "date": "2025-07-04",
    "locked": false,
    "updated_at": 1751518017,
    "created_at": 1751518017
  }
]
```

Events
------

Events are all the entries a user makes. Users can add, delete and edit all entries. Some user’s actions are restricted based on their access level in Timely.

Create an event
---------------

When a user creates an event on their own timesheet.

Note: By default, the event is created for a user’s first active project, or the project they last logged time to.

### Request

```
curl "https://api.timelyapp.com/1.1/1879/events" -d '{"event":{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:47:01.063Z","to":"2025-07-03T08:17:01.063Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","project_id":1927}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer VqyHrujaZypaFfGdqQct8Wh6p2AMbU7cNheB52_49WA" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/events`

```
POST /1.1/1879/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer VqyHrujaZypaFfGdqQct8Wh6p2AMbU7cNheB52_49WA
```

#### Parameters

```
{"event":{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:47:01.063Z","to":"2025-07-03T08:17:01.063Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","project_id":1927}}
```

| Name | Description |
| --- | --- |
| user_id | The numerical ID for the user who the event is created for. **Note:** the default value is the user_id connected to the API token. Example value: 123 |
| day _required_ | Event day |
| hours _required_ | Event hours |
| minutes _required_ | Event minutes |
| estimated_minutes | Specifies estimated minutes for an event. Example values: 0-60 |
| estimated_hours | Specifies estimated hours for an event. Example values: 0-12 |
| note | Specifies notes for an event |
| from | Specifies the “from” time in a timestamp. Example values: from: "2017-05-26T10:00:00+05:30" |
| to | Specifies the “to” time in a timestamp. Example values: to: "2017-05-26T12:00:00+05:30" |
| label_ids | Specifies label IDs for an event. Example values: label_ids:[2,3,4] |
| project_id | Specifies the project ID for an event |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 2889,
  "uid": "7f018eb7b301a66658931cb8a93fd6e8",
  "user": {
    "id": 4812,
    "email": "marijakoffpbjy@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/a3af956e0798a65fa7988d1fdf10500c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/a3af956e0798a65fa7988d1fdf10500c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/a3af956e0798a65fa7988d1fdf10500c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/a3af956e0798a65fa7988d1fdf10500c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/a3af956e0798a65fa7988d1fdf10500c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:00+02:00"
  },
  "project": {
    "id": 1927,
    "active": true,
    "account_id": 1879,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518021,
    "updated_at": 1751518021,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1383,
      "name": "Rerum voluptate quod et.",
      "color": "ffb74d",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:01+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 3,
    "minutes": 30,
    "seconds": 0,
    "formatted": "03:30",
    "total_hours": 3.5,
    "total_seconds": 12600,
    "total_minutes": 210
  },
  "estimated_duration": {
    "hours": 4,
    "minutes": 0,
    "seconds": 0,
    "formatted": "04:00",
    "total_hours": 4.0,
    "total_seconds": 14400,
    "total_minutes": 240
  },
  "cost": {
    "fractional": 35000,
    "formatted": "$350.00",
    "amount": 350.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 40000,
    "formatted": "$400.00",
    "amount": 400.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Notes for testing with some random #hash in it.",
  "sequence": 1,
  "estimated": false,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518021,
  "created_at": 1751518021,
  "created_from": "Timely",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:01+02:00",
  "from": "2025-07-03T06:47:01+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": 4812,
  "updater_id": 4812,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Create an event for a project
-----------------------------

### Request

```
curl "https://api.timelyapp.com/1.1/1878/projects/1926/events" -d '{"event":{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:47:00.673Z","to":"2025-07-03T08:17:00.673Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","project_id":1926}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer yZBj-6ttH7xvjqNf2OGwbO15VyveMRiYH-56WKOLGQs" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/projects/:project_id/events`

```
POST /1.1/1878/projects/1926/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer yZBj-6ttH7xvjqNf2OGwbO15VyveMRiYH-56WKOLGQs
```

#### Parameters

```
{"event":{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:47:00.673Z","to":"2025-07-03T08:17:00.673Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","project_id":1926}}
```

| Name | Description |
| --- | --- |
| user_id | The numerical ID for the user who the event is created for. **Note:** the default value is the user_id connected to the API token. Example value: 123 |
| day _required_ | Event day |
| hours _required_ | Event hours |
| minutes _required_ | Event minutes |
| project_id _required_ | The numerical ID of the desired project. Example values: 123 |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 2888,
  "uid": "488c1e0332065eb80e1129139a67d6e0",
  "user": {
    "id": 4810,
    "email": "marijaitxlakxy@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/f974aeea0fe3c24b9ba902428c9f9fc7?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/f974aeea0fe3c24b9ba902428c9f9fc7?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/f974aeea0fe3c24b9ba902428c9f9fc7?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/f974aeea0fe3c24b9ba902428c9f9fc7?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/f974aeea0fe3c24b9ba902428c9f9fc7?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:00+02:00"
  },
  "project": {
    "id": 1926,
    "active": true,
    "account_id": 1878,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518020,
    "updated_at": 1751518020,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1382,
      "name": "Vel vitae quam autem.",
      "color": "1976d2",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:00+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 3,
    "minutes": 30,
    "seconds": 0,
    "formatted": "03:30",
    "total_hours": 3.5,
    "total_seconds": 12600,
    "total_minutes": 210
  },
  "estimated_duration": {
    "hours": 4,
    "minutes": 0,
    "seconds": 0,
    "formatted": "04:00",
    "total_hours": 4.0,
    "total_seconds": 14400,
    "total_minutes": 240
  },
  "cost": {
    "fractional": 35000,
    "formatted": "$350.00",
    "amount": 350.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 40000,
    "formatted": "$400.00",
    "amount": 400.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Notes for testing with some random #hash in it.",
  "sequence": 1,
  "estimated": false,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518020,
  "created_at": 1751518020,
  "created_from": "Timely",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:00+02:00",
  "from": "2025-07-03T06:47:00+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": 4810,
  "updater_id": 4810,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Create an event for another user
--------------------------------

Note: Normal users can add hours for any user. If a project_id is not provided, the event is created against a user’s first active project, or the project they logged an event to in the last hour.

### Request

```
curl "https://api.timelyapp.com/1.1/1877/users/4808/events" -d '{"event":{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:47:00.291Z","to":"2025-07-03T08:17:00.291Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","user_id":4808}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YqL64Daz6Xd0vhnZK80nfubTbZsqErKXgf8omok1N1c" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/users/:user_id/events`

```
POST /1.1/1877/users/4808/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer YqL64Daz6Xd0vhnZK80nfubTbZsqErKXgf8omok1N1c
```

#### Parameters

```
{"event":{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:47:00.291Z","to":"2025-07-03T08:17:00.291Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","user_id":4808}}
```

| Name | Description |
| --- | --- |
| user_id _required_ | The numerical ID for the user who the event is created for. **Note:** the default value is the user_id connected to the API token. Example value: 123 |
| day _required_ | Event day |
| hours _required_ | Event hours |
| minutes _required_ | Event minutes |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 2887,
  "uid": "1dba5eed8838571e1c80af145184e515",
  "user": {
    "id": 4808,
    "email": "marijaguhlahjj@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/f4c9e0ad933944fa5098b0ba0be03abe?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/f4c9e0ad933944fa5098b0ba0be03abe?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/f4c9e0ad933944fa5098b0ba0be03abe?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/f4c9e0ad933944fa5098b0ba0be03abe?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/f4c9e0ad933944fa5098b0ba0be03abe?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:00+02:00"
  },
  "project": {
    "id": 1925,
    "active": true,
    "account_id": 1877,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518020,
    "updated_at": 1751518020,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1381,
      "name": "Est amet sed nesciunt.",
      "color": "b72367",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:00+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 3,
    "minutes": 30,
    "seconds": 0,
    "formatted": "03:30",
    "total_hours": 3.5,
    "total_seconds": 12600,
    "total_minutes": 210
  },
  "estimated_duration": {
    "hours": 4,
    "minutes": 0,
    "seconds": 0,
    "formatted": "04:00",
    "total_hours": 4.0,
    "total_seconds": 14400,
    "total_minutes": 240
  },
  "cost": {
    "fractional": 35000,
    "formatted": "$350.00",
    "amount": 350.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 40000,
    "formatted": "$400.00",
    "amount": 400.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Notes for testing with some random #hash in it.",
  "sequence": 1,
  "estimated": false,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518020,
  "created_at": 1751518020,
  "created_from": "Timely",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:00+02:00",
  "from": "2025-07-03T06:47:00+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": 4808,
  "updater_id": 4808,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Create bulk events
------------------

Note: Use the same list of sub-parameters inside your "create" parameter as specified on [Create an event](https://dev.timelyapp.com/#create-an-event). You can create up to 100 events at a time.

### Request

```
curl "https://api.timelyapp.com/1.1/1876/bulk/events" -d '{"create":[{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:46:59.917Z","to":"2025-07-03T08:16:59.917Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","user_id":4806,"account_id":1876,"project_id":1924}]}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer aKppVQ0J23D_XpFC--48PYdOWTGq7TkayYTmxevp3TQ" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/bulk/events`

```
POST /1.1/1876/bulk/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer aKppVQ0J23D_XpFC--48PYdOWTGq7TkayYTmxevp3TQ
```

#### Parameters

```
{"create":[{"hours":3,"minutes":30,"seconds":0,"estimated_hours":4,"estimated_minutes":0,"from":"2025-07-03T04:46:59.917Z","to":"2025-07-03T08:16:59.917Z","day":"2025-07-03","note":"Notes for testing with some random #hash in it.","hour_rate":100,"internal_hour_rate":150,"timer_state":0,"created_from":"Web","updated_from":"Web","user_id":4806,"account_id":1876,"project_id":1924}]}
```

| Name | Description |
| --- | --- |
| create | Specifies the parameters for creating a group of events. Example: [{ "hours": 3, "minutes": 30, "seconds": 0, "estimated_hours": 4, "estimated_minutes": 0, "from": "2021-03-04T11:33:36.570+01:00", "to": "2021-03-04T15:03:36.570+01:00", "day": "2021-03-04", "note": "Describe what you worked on here!", "hour_rate": 100, "timer_state": 0, "billed": true, "user_id": 1616, "account_id": 651, "project_id": 620}] |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "deleted_ids": [],
  "created_ids": [
    2886
  ],
  "updated_ids": [],
  "errors": {
    "create": [],
    "update": [],
    "delete": []
  },
  "job": null
}
```

Delete an event
---------------

Note: Normal users can delete events logged to other projects by other users on an account. Limited users can only delete their own events.

### Request

```
curl "https://api.timelyapp.com/1.1/1881/events/2891" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer lFDjfD-ODJ8l5nE5LWCQfD-XqOsVQCnQ8FfxXDeV3DM" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/events/:id`

```
DELETE /1.1/1881/events/2891
Accept: application/json
Content-Type: application/json
Authorization: Bearer lFDjfD-ODJ8l5nE5LWCQfD-XqOsVQCnQ8FfxXDeV3DM
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the hour you want to delete |
| id _required_ | The ID for the hour you want to delete |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

Delete bulk events
------------------

Note: You can delete up to 100 events at a time.

### Request

```
curl "https://api.timelyapp.com/1.1/1880/bulk/events" -d '{"delete":[2890]}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer dvvorRZROgK0s0_P0oBiCgv7VhcGgkqz_r0gZhGR2Ws" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/bulk/events`

```
POST /1.1/1880/bulk/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer dvvorRZROgK0s0_P0oBiCgv7VhcGgkqz_r0gZhGR2Ws
```

#### Parameters

```
{"delete":[2890]}
```

| Name | Description |
| --- | --- |
| delete | Specifies the parameters for deleting a group of events. Example: [ 320, 333 ] |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "deleted_ids": [
    2890
  ],
  "created_ids": [],
  "updated_ids": [],
  "errors": {
    "create": [],
    "update": [],
    "delete": []
  },
  "job": null
}
```

List all events
---------------

Get all events linked to active projects on a user’s account.

Note: By default, the API retrieves events from the current date (date of access). To specify a different time range, you need to provide both the “since” and “upto” parameters.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1886/events" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer TYls7P_zNqvuzoqVaJcIbJbE5KYeTUNFY15VC7QZ5ow" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/events`

```
GET /1.1/1886/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer TYls7P_zNqvuzoqVaJcIbJbE5KYeTUNFY15VC7QZ5ow
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the hours you want to retrieve. |
| day | Specifies the date for returned events. (Default "current date") Example: day=2014-08-24 |
| since | Specifies the start date for returned results. Example: since=2014-08-18 |
| upto | Specifies the end date for returned results. Example: upto=2014-08-24 |
| filter | Specifies which events to retrieve - logged, all (Default logged) |
| sort | Field to sort events by - updated_at, id, day (Default updated_at) |
| order | Order to retrieve records - desc, asc (Default desc) |
| per_page | Records per page (Default 100) |
| page | Page number (Default 1) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 2896,
    "uid": "e8f2779682fd11fa2067beffc27a9192",
    "user": {
      "id": 4826,
      "email": "marijasxonbjej@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/b43501d2ada05a812c9472a42e4d9963?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/b43501d2ada05a812c9472a42e4d9963?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/b43501d2ada05a812c9472a42e4d9963?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/b43501d2ada05a812c9472a42e4d9963?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/b43501d2ada05a812c9472a42e4d9963?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:47:03+02:00"
    },
    "project": {
      "id": 1934,
      "active": true,
      "account_id": 1886,
      "name": "Timely",
      "description": "Project Description",
      "color": "67a3bc",
      "rate_type": "project",
      "billable": true,
      "created_at": 1751518023,
      "updated_at": 1751518023,
      "external_id": null,
      "budget_scope": null,
      "client": {
        "id": 1390,
        "name": "Voluptatem nostrum fugit incidunt.",
        "color": "7e57c2",
        "active": true,
        "external_id": null,
        "updated_at": "2025-07-03T06:47:03+02:00"
      },
      "required_notes": false,
      "required_labels": false,
      "budget_expired_on": null,
      "has_recurrence": false,
      "enable_labels": "all",
      "default_labels": false,
      "currency": {
        "id": "usd",
        "name": "United States Dollar",
        "iso_code": "USD",
        "symbol": "$",
        "symbol_first": true
      },
      "team_ids": [],
      "budget": 0,
      "budget_type": "",
      "budget_calculation": "completed",
      "hour_rate": 50.0,
      "hour_rate_in_cents": 5000.0,
      "budget_progress": 0.0,
      "budget_percent": 0.0,
      "invoice_by_budget": false,
      "labels": [],
      "label_ids": [],
      "required_label_ids": [],
      "default_label_ids": [],
      "created_from": "Web"
    },
    "duration": {
      "hours": 3,
      "minutes": 30,
      "seconds": 0,
      "formatted": "03:30",
      "total_hours": 3.5,
      "total_seconds": 12600,
      "total_minutes": 210
    },
    "estimated_duration": {
      "hours": 4,
      "minutes": 0,
      "seconds": 0,
      "formatted": "04:00",
      "total_hours": 4.0,
      "total_seconds": 14400,
      "total_minutes": 240
    },
    "cost": {
      "fractional": 35000,
      "formatted": "$350.00",
      "amount": 350.0,
      "currency_code": "usd"
    },
    "estimated_cost": {
      "fractional": 40000,
      "formatted": "$400.00",
      "amount": 400.0,
      "currency_code": "usd"
    },
    "day": "2025-07-03",
    "note": "Notes for testing with some random #hash in it.",
    "sequence": 1,
    "estimated": false,
    "timer_state": "default",
    "timer_started_on": 0,
    "timer_stopped_on": 0,
    "label_ids": [],
    "user_ids": [],
    "updated_at": 1751518023,
    "created_at": 1751518023,
    "created_from": "Web",
    "updated_from": "Web",
    "billed": false,
    "billable": true,
    "to": "2025-07-03T10:17:03+02:00",
    "from": "2025-07-03T06:47:03+02:00",
    "deleted": false,
    "hour_rate": 100.0,
    "hour_rate_in_cents": 10000,
    "creator_id": null,
    "updater_id": null,
    "external_id": null,
    "entry_ids": [],
    "suggestion_id": null,
    "draft": false,
    "manage": true,
    "forecast_id": null,
    "billed_at": null,
    "external_link_ids": [],
    "internal_cost": {},
    "estimated_internal_cost": {},
    "internal_cost_rate": 0,
    "profit": 0,
    "profitability": 0,
    "locked_reason": null,
    "locked": false,
    "invoice_id": null,
    "timestamps": [],
    "state": null,
    "external_links": []
  }
]
```

List all events for a project
-----------------------------

Note: By default, the API retrieves events from the current date (date of access). To specify a different time range, you need to provide both the “since” and “upto” parameters.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1889/projects/1937/events" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer GLngTZuD4kdTa7yJgjWjueA3u45YleIS5iGXc2G7FvQ" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/projects/:project_id/events`

```
GET /1.1/1889/projects/1937/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer GLngTZuD4kdTa7yJgjWjueA3u45YleIS5iGXc2G7FvQ
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the hours you want to retrieve |
| project_id | The project ID for the hours you want to retrieve |
| day | Specifies the date for returned events. (Default "current date") Example: day=2014-08-24 |
| since | Specifies the start date for returned results. Example: since=2014-08-18 |
| upto | Specifies the end date for returned results. Example: upto=2014-08-24 |
| sort | Field to sort events by - updated_at, id, day (Default updated_at) |
| order | Order to retrieve records - desc, asc (Default desc) |
| per_page | Records per page (Default 100) |
| page | Page number (Default 1) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 2899,
    "uid": "332647f433a1c10fa2e2ae04abfdf83e",
    "user": {
      "id": 4832,
      "email": "marijaeebhudub@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/cc770fb8b260583408726949a70c66d9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/cc770fb8b260583408726949a70c66d9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/cc770fb8b260583408726949a70c66d9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/cc770fb8b260583408726949a70c66d9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/cc770fb8b260583408726949a70c66d9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:47:04+02:00"
    },
    "project": {
      "id": 1937,
      "active": true,
      "account_id": 1889,
      "name": "Timely",
      "description": "Project Description",
      "color": "67a3bc",
      "rate_type": "project",
      "billable": true,
      "created_at": 1751518024,
      "updated_at": 1751518024,
      "external_id": null,
      "budget_scope": null,
      "client": {
        "id": 1393,
        "name": "Ducimus id culpa qui.",
        "color": "ffeb3b",
        "active": true,
        "external_id": null,
        "updated_at": "2025-07-03T06:47:04+02:00"
      },
      "required_notes": false,
      "required_labels": false,
      "budget_expired_on": null,
      "has_recurrence": false,
      "enable_labels": "all",
      "default_labels": false,
      "currency": {
        "id": "usd",
        "name": "United States Dollar",
        "iso_code": "USD",
        "symbol": "$",
        "symbol_first": true
      },
      "team_ids": [],
      "budget": 0,
      "budget_type": "",
      "budget_calculation": "completed",
      "hour_rate": 50.0,
      "hour_rate_in_cents": 5000.0,
      "budget_progress": 0.0,
      "budget_percent": 0.0,
      "invoice_by_budget": false,
      "labels": [],
      "label_ids": [],
      "required_label_ids": [],
      "default_label_ids": [],
      "created_from": "Web"
    },
    "duration": {
      "hours": 3,
      "minutes": 30,
      "seconds": 0,
      "formatted": "03:30",
      "total_hours": 3.5,
      "total_seconds": 12600,
      "total_minutes": 210
    },
    "estimated_duration": {
      "hours": 4,
      "minutes": 0,
      "seconds": 0,
      "formatted": "04:00",
      "total_hours": 4.0,
      "total_seconds": 14400,
      "total_minutes": 240
    },
    "cost": {
      "fractional": 35000,
      "formatted": "$350.00",
      "amount": 350.0,
      "currency_code": "usd"
    },
    "estimated_cost": {
      "fractional": 40000,
      "formatted": "$400.00",
      "amount": 400.0,
      "currency_code": "usd"
    },
    "day": "2025-07-03",
    "note": "Notes for testing with some random #hash in it.",
    "sequence": 1,
    "estimated": false,
    "timer_state": "default",
    "timer_started_on": 0,
    "timer_stopped_on": 0,
    "label_ids": [],
    "user_ids": [],
    "updated_at": 1751518024,
    "created_at": 1751518024,
    "created_from": "Web",
    "updated_from": "Web",
    "billed": false,
    "billable": true,
    "to": "2025-07-03T10:17:04+02:00",
    "from": "2025-07-03T06:47:04+02:00",
    "deleted": false,
    "hour_rate": 100.0,
    "hour_rate_in_cents": 10000,
    "creator_id": null,
    "updater_id": null,
    "external_id": null,
    "entry_ids": [],
    "suggestion_id": null,
    "draft": false,
    "manage": true,
    "forecast_id": null,
    "billed_at": null,
    "external_link_ids": [],
    "internal_cost": {},
    "estimated_internal_cost": {},
    "internal_cost_rate": 0,
    "profit": 0,
    "profitability": 0,
    "locked_reason": null,
    "locked": false,
    "invoice_id": null,
    "timestamps": [],
    "state": null,
    "external_links": []
  }
]
```

List all events for a user
--------------------------

Note: By default, the API retrieves events from the current date (date of access). To specify a different time range, you need to provide both the “since” and “upto” parameters.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1888/users/4830/events" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer OfGCJSNGm-ImVI0fOVmesZMJEwD43JpuMk9OxQgXlJI" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/:user_id/events`

```
GET /1.1/1888/users/4830/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer OfGCJSNGm-ImVI0fOVmesZMJEwD43JpuMk9OxQgXlJI
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the hours you want to retrieve |
| user_id | The user ID for the hours you want to retrieve |
| day | Specifies the date for returned events. (Default "current date") Example: day=2014-08-24 |
| since | Specifies the start date for returned results. Example: since=2014-08-18 |
| upto | Specifies the end date for returned results. Example: upto=2014-08-24 |
| sort | Field to sort events by - updated_at, id, day (Default updated_at) |
| order | Order to retrieve records - desc, asc (Default desc) |
| per_page | Records per page (Default 100) |
| page | Page number (Default 1) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 2898,
    "uid": "25ef0d887bc7a2b30089a025618e1c62",
    "user": {
      "id": 4830,
      "email": "marijamnhpgysv@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/1c6c1ad944fbb413016ab6677203990d?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/1c6c1ad944fbb413016ab6677203990d?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/1c6c1ad944fbb413016ab6677203990d?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/1c6c1ad944fbb413016ab6677203990d?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/1c6c1ad944fbb413016ab6677203990d?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:47:04+02:00"
    },
    "project": {
      "id": 1936,
      "active": true,
      "account_id": 1888,
      "name": "Timely",
      "description": "Project Description",
      "color": "67a3bc",
      "rate_type": "project",
      "billable": true,
      "created_at": 1751518024,
      "updated_at": 1751518024,
      "external_id": null,
      "budget_scope": null,
      "client": {
        "id": 1392,
        "name": "Laboriosam quidem suscipit et.",
        "color": "7e57c2",
        "active": true,
        "external_id": null,
        "updated_at": "2025-07-03T06:47:04+02:00"
      },
      "required_notes": false,
      "required_labels": false,
      "budget_expired_on": null,
      "has_recurrence": false,
      "enable_labels": "all",
      "default_labels": false,
      "currency": {
        "id": "usd",
        "name": "United States Dollar",
        "iso_code": "USD",
        "symbol": "$",
        "symbol_first": true
      },
      "team_ids": [],
      "budget": 0,
      "budget_type": "",
      "budget_calculation": "completed",
      "hour_rate": 50.0,
      "hour_rate_in_cents": 5000.0,
      "budget_progress": 0.0,
      "budget_percent": 0.0,
      "invoice_by_budget": false,
      "labels": [],
      "label_ids": [],
      "required_label_ids": [],
      "default_label_ids": [],
      "created_from": "Web"
    },
    "duration": {
      "hours": 3,
      "minutes": 30,
      "seconds": 0,
      "formatted": "03:30",
      "total_hours": 3.5,
      "total_seconds": 12600,
      "total_minutes": 210
    },
    "estimated_duration": {
      "hours": 4,
      "minutes": 0,
      "seconds": 0,
      "formatted": "04:00",
      "total_hours": 4.0,
      "total_seconds": 14400,
      "total_minutes": 240
    },
    "cost": {
      "fractional": 35000,
      "formatted": "$350.00",
      "amount": 350.0,
      "currency_code": "usd"
    },
    "estimated_cost": {
      "fractional": 40000,
      "formatted": "$400.00",
      "amount": 400.0,
      "currency_code": "usd"
    },
    "day": "2025-07-03",
    "note": "Notes for testing with some random #hash in it.",
    "sequence": 1,
    "estimated": false,
    "timer_state": "default",
    "timer_started_on": 0,
    "timer_stopped_on": 0,
    "label_ids": [],
    "user_ids": [],
    "updated_at": 1751518024,
    "created_at": 1751518024,
    "created_from": "Web",
    "updated_from": "Web",
    "billed": false,
    "billable": true,
    "to": "2025-07-03T10:17:04+02:00",
    "from": "2025-07-03T06:47:04+02:00",
    "deleted": false,
    "hour_rate": 100.0,
    "hour_rate_in_cents": 10000,
    "creator_id": null,
    "updater_id": null,
    "external_id": null,
    "entry_ids": [],
    "suggestion_id": null,
    "draft": false,
    "manage": true,
    "forecast_id": null,
    "billed_at": null,
    "external_link_ids": [],
    "internal_cost": {},
    "estimated_internal_cost": {},
    "internal_cost_rate": 0,
    "profit": 0,
    "profitability": 0,
    "locked_reason": null,
    "locked": false,
    "invoice_id": null,
    "timestamps": [],
    "state": null,
    "external_links": []
  }
]
```

Logged in user updating details and user of an event
----------------------------------------------------

### Request

```
curl "https://api.timelyapp.com/1.1/1897/users/4848/events/2907" -d '{"event":{"note":"Updated details and project","minutes":0,"hours":0,"estimated":true,"estimated_minutes":0,"estimated_hours":2}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer bqED9eorSyqYLSPdagakrNf_CIr9m8uoXpJ-iT8mkAE" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/users/:user_id/events/:id`

```
PUT /1.1/1897/users/4848/events/2907
Accept: application/json
Content-Type: application/json
Authorization: Bearer bqED9eorSyqYLSPdagakrNf_CIr9m8uoXpJ-iT8mkAE
```

#### Parameters

```
{"event":{"note":"Updated details and project","minutes":0,"hours":0,"estimated":true,"estimated_minutes":0,"estimated_hours":2}}
```

| Name | Description |
| --- | --- |
| id _required_ | Event ID |
| day _required_ | Event day |
| hours _required_ | Event hours |
| minutes _required_ | Event minutes |
| estimated_minutes | Specifies estimated minutes for an event. Example values: 0-60 |
| estimated_hours | Specifies estimated hours for an event. Example values: 0-12 |
| note | Specifies notes for an event |
| from | Specifies the “from” time in a timestamp. Example values: from: "2017-05-26T10:00:00+05:30" |
| to | Specifies the “to” time in a timestamp. Example values: to: "2017-05-26T12:00:00+05:30" |
| label_ids | Specifies label IDs for an event. Example values: label_ids:[2,3,4] |
| project_id | Specifies the project ID for an event |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2907,
  "uid": "c7558e9d1f956b016d1fdba7ea132378",
  "user": {
    "id": 4848,
    "email": "marijaoccdhmuf@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/046f140443bcd2779e6cf59f48fb1be8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/046f140443bcd2779e6cf59f48fb1be8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/046f140443bcd2779e6cf59f48fb1be8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/046f140443bcd2779e6cf59f48fb1be8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/046f140443bcd2779e6cf59f48fb1be8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:07+02:00"
  },
  "project": {
    "id": 1945,
    "active": true,
    "account_id": 1897,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518027,
    "updated_at": 1751518027,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1401,
      "name": "Similique dolore ut cupiditate.",
      "color": "b72367",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:07+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "estimated_duration": {
    "hours": 2,
    "minutes": 0,
    "seconds": 0,
    "formatted": "02:00",
    "total_hours": 2.0,
    "total_seconds": 7200,
    "total_minutes": 120
  },
  "cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 20000,
    "formatted": "$200.00",
    "amount": 200.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Updated details and project",
  "sequence": 1,
  "estimated": true,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518027,
  "created_at": 1751518027,
  "created_from": "Web",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:07+02:00",
  "from": "2025-07-03T06:47:07+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": null,
  "updater_id": 4848,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Loggedin user updating details and project of their event
---------------------------------------------------------

### Request

```
curl "https://api.timelyapp.com/1.1/1896/projects/1944/events/2906" -d '{"event":{"note":"Updated details and project","minutes":0,"hours":0,"estimated":true,"estimated_minutes":0,"estimated_hours":2}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 7_ksEeZCdVvdu2PTiHgHklc09kq5o89WDiYAiXp0EVY" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/projects/:project_id/events/:id`

```
PUT /1.1/1896/projects/1944/events/2906
Accept: application/json
Content-Type: application/json
Authorization: Bearer 7_ksEeZCdVvdu2PTiHgHklc09kq5o89WDiYAiXp0EVY
```

#### Parameters

```
{"event":{"note":"Updated details and project","minutes":0,"hours":0,"estimated":true,"estimated_minutes":0,"estimated_hours":2}}
```

| Name | Description |
| --- | --- |
| id _required_ | Event ID |
| project_id _required_ | Project ID |
| day _required_ | Event day |
| hours _required_ | Event hours |
| minutes _required_ | Event minutes |
| estimated_minutes | Specifies estimated minutes for an event. Example values: 0-60 |
| estimated_hours | Specifies estimated hours for an event. Example values: 0-12 |
| note | Specifies notes for an event |
| from | Specifies the “from” time in a timestamp. Example values: from: "2017-05-26T10:00:00+05:30" |
| to | Specifies the “to” time in a timestamp. Example values: to: "2017-05-26T12:00:00+05:30" |
| label_ids | Specifies label IDs for an event. Example values: label_ids:[2,3,4] |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2906,
  "uid": "9e82757e9a1c12cb710ad680db11f6f1",
  "user": {
    "id": 4846,
    "email": "marijazqpmkgfn@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/e9cacbbbf8bdbeb161c9bd2b30c6608b?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/e9cacbbbf8bdbeb161c9bd2b30c6608b?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/e9cacbbbf8bdbeb161c9bd2b30c6608b?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/e9cacbbbf8bdbeb161c9bd2b30c6608b?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/e9cacbbbf8bdbeb161c9bd2b30c6608b?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:07+02:00"
  },
  "project": {
    "id": 1944,
    "active": true,
    "account_id": 1896,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518027,
    "updated_at": 1751518027,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1400,
      "name": "Reprehenderit est et ut.",
      "color": "ffb74d",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:07+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "estimated_duration": {
    "hours": 2,
    "minutes": 0,
    "seconds": 0,
    "formatted": "02:00",
    "total_hours": 2.0,
    "total_seconds": 7200,
    "total_minutes": 120
  },
  "cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 20000,
    "formatted": "$200.00",
    "amount": 200.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Updated details and project",
  "sequence": 1,
  "estimated": true,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518027,
  "created_at": 1751518027,
  "created_from": "Web",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:07+02:00",
  "from": "2025-07-03T06:47:07+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": null,
  "updater_id": 4846,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Retrieve an event
-----------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/1884/events/2894" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer xsnufnyslZvirnuGkFkKm9SGzoANjd-AuFeUS9g2kXo" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/events/:id`

```
GET /1.1/1884/events/2894
Accept: application/json
Content-Type: application/json
Authorization: Bearer xsnufnyslZvirnuGkFkKm9SGzoANjd-AuFeUS9g2kXo
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the hour you want to retrieve |
| id | The ID of the hour you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2894,
  "uid": "5b4130c9e891d39891289001cc97d86b",
  "user": {
    "id": 4822,
    "email": "marijawpyzmbmz@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/7093c9a79c90b50a30b4128e867eae38?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/7093c9a79c90b50a30b4128e867eae38?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/7093c9a79c90b50a30b4128e867eae38?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/7093c9a79c90b50a30b4128e867eae38?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/7093c9a79c90b50a30b4128e867eae38?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:02+02:00"
  },
  "project": {
    "id": 1932,
    "active": true,
    "account_id": 1884,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518022,
    "updated_at": 1751518022,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1388,
      "name": "Quo corporis enim cupiditate.",
      "color": "b72367",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:02+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 3,
    "minutes": 30,
    "seconds": 0,
    "formatted": "03:30",
    "total_hours": 3.5,
    "total_seconds": 12600,
    "total_minutes": 210
  },
  "estimated_duration": {
    "hours": 4,
    "minutes": 0,
    "seconds": 0,
    "formatted": "04:00",
    "total_hours": 4.0,
    "total_seconds": 14400,
    "total_minutes": 240
  },
  "cost": {
    "fractional": 35000,
    "formatted": "$350.00",
    "amount": 350.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 40000,
    "formatted": "$400.00",
    "amount": 400.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Notes for testing with some random #hash in it.",
  "sequence": 1,
  "estimated": false,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518022,
  "created_at": 1751518022,
  "created_from": "Web",
  "updated_from": "Web",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:02+02:00",
  "from": "2025-07-03T06:47:02+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": null,
  "updater_id": null,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Start timer on an event
-----------------------

### Request

```
curl "https://api.timelyapp.com/1.1/1890/events/2900/start" -d '' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer luKg3O_BtfnvX2RDyNtk-P70iFP4nZ59nb6NuMCxsIs" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/events/:id/start`

```
PUT /1.1/1890/events/2900/start
Accept: application/json
Content-Type: application/json
Authorization: Bearer luKg3O_BtfnvX2RDyNtk-P70iFP4nZ59nb6NuMCxsIs
```

#### Parameters

| Name | Description |
| --- | --- |
| id _required_ | Event ID |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2900,
  "uid": "f9fd2624beefbc7808e4e405d73f57ab",
  "user": {
    "id": 4834,
    "email": "marijahhtliogy@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/66868b0ca4ac9a3269e790f2d3cdeefc?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/66868b0ca4ac9a3269e790f2d3cdeefc?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/66868b0ca4ac9a3269e790f2d3cdeefc?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/66868b0ca4ac9a3269e790f2d3cdeefc?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/66868b0ca4ac9a3269e790f2d3cdeefc?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:04+02:00"
  },
  "project": {
    "id": 1938,
    "active": true,
    "account_id": 1890,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518025,
    "updated_at": 1751518025,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1394,
      "name": "Numquam architecto et optio.",
      "color": "7e57c2",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:05+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 3,
    "minutes": 30,
    "seconds": 0,
    "formatted": "03:30",
    "total_hours": 3.5,
    "total_seconds": 12600,
    "total_minutes": 210
  },
  "estimated_duration": {
    "hours": 4,
    "minutes": 0,
    "seconds": 0,
    "formatted": "04:00",
    "total_hours": 4.0,
    "total_seconds": 14400,
    "total_minutes": 240
  },
  "cost": {
    "fractional": 35000,
    "formatted": "$350.00",
    "amount": 350.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 40000,
    "formatted": "$400.00",
    "amount": 400.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Notes for testing with some random #hash in it.",
  "sequence": 1,
  "estimated": false,
  "timer_state": "start",
  "timer_started_on": 1751518025,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518025,
  "created_at": 1751518025,
  "created_from": "Web",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:05+02:00",
  "from": "2025-07-03T06:47:05+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": null,
  "updater_id": 4834,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [
    {
      "id": 36,
      "hour_id": 2900,
      "from": "2025-07-03T03:17:05+02:00",
      "to": "2025-07-03T06:47:05+02:00",
      "entry_ids": []
    }
  ],
  "state": null,
  "external_links": []
}
```

Stop timer on an event
----------------------

### Request

```
curl "https://api.timelyapp.com/1.1/1891/events/2901/stop" -d '' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer lnN0P0_-6dMvbGM0yjhCxRlzvnb_JwYG0ZdlmA3KMjk" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/events/:id/stop`

```
PUT /1.1/1891/events/2901/stop
Accept: application/json
Content-Type: application/json
Authorization: Bearer lnN0P0_-6dMvbGM0yjhCxRlzvnb_JwYG0ZdlmA3KMjk
```

#### Parameters

| Name | Description |
| --- | --- |
| id _required_ | Event ID |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2901,
  "uid": "a57e8915461b83adefb011530b711704",
  "user": {
    "id": 4836,
    "email": "marijadmymqfjt@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/207cb83a7413dbed252d9fa4e83cfd9c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/207cb83a7413dbed252d9fa4e83cfd9c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/207cb83a7413dbed252d9fa4e83cfd9c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/207cb83a7413dbed252d9fa4e83cfd9c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/207cb83a7413dbed252d9fa4e83cfd9c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:05+02:00"
  },
  "project": {
    "id": 1939,
    "active": true,
    "account_id": 1891,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518025,
    "updated_at": 1751518025,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1395,
      "name": "Qui nulla dolor labore.",
      "color": "ffeb3b",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:05+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 4,
    "minutes": 30,
    "seconds": 0,
    "formatted": "04:30",
    "total_hours": 4.5,
    "total_seconds": 16200,
    "total_minutes": 270
  },
  "estimated_duration": {
    "hours": 4,
    "minutes": 0,
    "seconds": 0,
    "formatted": "04:00",
    "total_hours": 4.0,
    "total_seconds": 14400,
    "total_minutes": 240
  },
  "cost": {
    "fractional": 45000,
    "formatted": "$450.00",
    "amount": 450.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 40000,
    "formatted": "$400.00",
    "amount": 400.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Notes for testing with some random #hash in it.",
  "sequence": 1,
  "estimated": false,
  "timer_state": "stop",
  "timer_started_on": 0,
  "timer_stopped_on": 1751518025,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518025,
  "created_at": 1751518025,
  "created_from": "Web",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:05+02:00",
  "from": "2025-07-03T06:47:05+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": null,
  "updater_id": 4836,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Update an event
---------------

### Request

```
curl "https://api.timelyapp.com/1.1/1895/events/2905" -d '{"event":{"note":"Updated notes","minutes":0,"hours":0,"estimated":true,"estimated_minutes":0,"estimated_hours":2}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer wVG_TapEK6ym64AvpFz0e0p0ZRWFszGr-8Qm3dZjZCY" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/events/:id`

```
PUT /1.1/1895/events/2905
Accept: application/json
Content-Type: application/json
Authorization: Bearer wVG_TapEK6ym64AvpFz0e0p0ZRWFszGr-8Qm3dZjZCY
```

#### Parameters

```
{"event":{"note":"Updated notes","minutes":0,"hours":0,"estimated":true,"estimated_minutes":0,"estimated_hours":2}}
```

| Name | Description |
| --- | --- |
| user_id | The numerical ID for the user who the event is updated for. **Note:** the default value is the user_id connected to the API token. Example value: 123 |
| id _required_ | Event ID |
| day _required_ | Event day |
| hours _required_ | Event hours |
| minutes _required_ | Event minutes |
| project_id | Project ID |
| estimated_minutes | Specifies estimated minutes for an event. Example values: 0-60 |
| estimated_hours | Specifies estimated hours for an event. Example values: 0-12 |
| note | Specifies notes for an event |
| from | Specifies the “from” time in a timestamp. Example values: from: "2017-05-26T10:00:00+05:30" |
| to | Specifies the “to” time in a timestamp. Example values: to: "2017-05-26T12:00:00+05:30" |
| label_ids | Specifies label IDs for an event. Example values: label_ids:[2,3,4] |
| external_id | The external_id can be used to reference external resource ids to Timely resources, should be alphanumeric 512 characters |
| billed | Specifies whether you want an event to be marked as billed. For example: 'billed': false or 'billed': true |
| billable | Specifies whether you want an event to be billable or non-billable. For example: 'billable': false or 'billable': true |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2905,
  "uid": "314450613369e0ee72d0da7f6fee773c",
  "user": {
    "id": 4844,
    "email": "marijalhrcbylu@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/d692ba82f425e9e917273cf9643c2905?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/d692ba82f425e9e917273cf9643c2905?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/d692ba82f425e9e917273cf9643c2905?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/d692ba82f425e9e917273cf9643c2905?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/d692ba82f425e9e917273cf9643c2905?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:06+02:00"
  },
  "project": {
    "id": 1943,
    "active": true,
    "account_id": 1895,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518027,
    "updated_at": 1751518027,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1399,
      "name": "Eius dolor aut laboriosam.",
      "color": "7e57c2",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:07+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "created_from": "Web"
  },
  "duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "estimated_duration": {
    "hours": 2,
    "minutes": 0,
    "seconds": 0,
    "formatted": "02:00",
    "total_hours": 2.0,
    "total_seconds": 7200,
    "total_minutes": 120
  },
  "cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 20000,
    "formatted": "$200.00",
    "amount": 200.0,
    "currency_code": "usd"
  },
  "day": "2025-07-03",
  "note": "Updated notes",
  "sequence": 1,
  "estimated": true,
  "timer_state": "default",
  "timer_started_on": 0,
  "timer_stopped_on": 0,
  "label_ids": [],
  "user_ids": [],
  "updated_at": 1751518027,
  "created_at": 1751518027,
  "created_from": "Web",
  "updated_from": "Timely",
  "billed": false,
  "billable": true,
  "to": "2025-07-03T10:17:07+02:00",
  "from": "2025-07-03T06:47:07+02:00",
  "deleted": false,
  "hour_rate": 100.0,
  "hour_rate_in_cents": 10000,
  "creator_id": null,
  "updater_id": 4844,
  "external_id": null,
  "entry_ids": [],
  "suggestion_id": null,
  "draft": false,
  "manage": true,
  "forecast_id": null,
  "billed_at": null,
  "external_link_ids": [],
  "internal_cost": {},
  "estimated_internal_cost": {},
  "internal_cost_rate": 0,
  "profit": 0,
  "profitability": 0,
  "locked_reason": null,
  "locked": false,
  "invoice_id": null,
  "timestamps": [],
  "state": null,
  "external_links": []
}
```

Update bulk events
------------------

Note: Use the same list of sub-parameters inside your "update" parameter as specified on [Update an event](https://dev.timelyapp.com/#update-an-event). You can update up to 100 events at a time.

### Request

```
curl "https://api.timelyapp.com/1.1/1892/bulk/events" -d '{"update":[{"id":2902,"note":"updated","billed":true}]}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ebDiYEx5O1tdHbi7XE9WptPJRVG6u1wLbZlLEP0oAw0" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/bulk/events`

```
POST /1.1/1892/bulk/events
Accept: application/json
Content-Type: application/json
Authorization: Bearer ebDiYEx5O1tdHbi7XE9WptPJRVG6u1wLbZlLEP0oAw0
```

#### Parameters

```
{"update":[{"id":2902,"note":"updated","billed":true}]}
```

| Name | Description |
| --- | --- |
| update | Specifies the parameters for updating a group of events. Example: [{ "id": 1055, "note": "updated", "billed": true }] |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "deleted_ids": [],
  "created_ids": [],
  "updated_ids": [
    2902
  ],
  "errors": {
    "create": [],
    "update": [],
    "delete": []
  },
  "job": null
}
```

Forecasts (Tasks)
-----------------

Forecasts (Tasks) lets you visualize upcoming work for all Timely users in one clean calendar view. You can then quickly assign work or edit plans across your different projects and teams.

Create a forecast
-----------------

### Request

```
curl "https://api.timelyapp.com/1.1/1929/forecasts" -d '{"forecast":{"from":"2022-05-10","to":"2022-05-16","estimated_minutes":150,"users":[{"id":4911}],"project_id":1960,"title":"Title"}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer TqhRkBjY1J2i_NVMXB1z275chTsYg5vxGDH-IYJm3nU" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/forecasts`

```
POST /1.1/1929/forecasts
Accept: application/json
Content-Type: application/json
Authorization: Bearer TqhRkBjY1J2i_NVMXB1z275chTsYg5vxGDH-IYJm3nU
```

#### Parameters

```
{"forecast":{"from":"2022-05-10","to":"2022-05-16","estimated_minutes":150,"users":[{"id":4911}],"project_id":1960,"title":"Title"}}
```

| Name | Description |
| --- | --- |
| estimated_minutes | Forecast minutes |
| title | Specifies title for a forecast |
| from | Specifies the “from” time in a timestamp. Example values: from: "2022-05-26T10:00:00+05:30" |
| to | Specifies the “to” time in a timestamp. Example values: to: "2022-05-26T12:00:00+05:30" |
| users | Forecast assignees. Example values: [{ id: 1 }, { id: 3 }] |
| project_id _required_ | The numerical ID of the desired project. Example values: 123 |
| label_ids | Specifies label IDs for a forecast. Example values: label_ids:[2,3,4] |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 234,
  "note": "Title",
  "title": "Title",
  "description": "",
  "from": "2022-05-10",
  "to": "2022-05-16",
  "user": {
    "id": 4911,
    "email": "marijahkgbflou@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:10+02:00",
    "estimated_minutes": 150,
    "estimated_duration": {
      "hours": 2,
      "minutes": 30,
      "seconds": 0,
      "formatted": "02:30",
      "total_hours": 2.5,
      "total_seconds": 9000,
      "total_minutes": 150
    },
    "weekly_capacity": 40.0,
    "work_days": "MON,TUE,WED,THU,FRI",
    "weekdays": "MO,TU,WE,TH,FR"
  },
  "users": [
    {
      "id": 4911,
      "email": "marijahkgbflou@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/3129e5d0c626cb34f60b36f09d4291c6?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:47:10+02:00",
      "estimated_minutes": 0,
      "estimated_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "weekly_capacity": 40.0,
      "work_days": "MON,TUE,WED,THU,FRI",
      "weekdays": "MO,TU,WE,TH,FR"
    }
  ],
  "project": {
    "id": 1960,
    "active": true,
    "name": "Timely",
    "color": "67a3bc",
    "client": {
      "id": 1424,
      "name": "Omnis molestiae dicta qui.",
      "color": "00796b",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:11+02:00"
    },
    "updated_at": "2025-07-03T06:47:11+02:00"
  },
  "estimated_minutes": 150,
  "updated_at": "2025-07-03T06:47:11+02:00",
  "created_at": "2025-07-03T06:47:11+02:00",
  "label_ids": [],
  "estimated_duration": {
    "hours": 2,
    "minutes": 30,
    "seconds": 0,
    "formatted": "02:30",
    "total_hours": 2.5,
    "total_seconds": 9000,
    "total_minutes": 150
  },
  "planned_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "logged_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "completed": false,
  "completed_at": null,
  "manage": true,
  "external_id": null,
  "parent_title": "Title"
}
```

Delete a forecast
-----------------

### Request

```
curl "https://api.timelyapp.com/1.1/1930/forecasts/235" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer AvJ8Ip0x0ZobgAYC827XfSf1GnJ6nAh5s4mHikjVzFw" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/forecasts/:id`

```
DELETE /1.1/1930/forecasts/235
Accept: application/json
Content-Type: application/json
Authorization: Bearer AvJ8Ip0x0ZobgAYC827XfSf1GnJ6nAh5s4mHikjVzFw
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the forecast you want to delete |
| id _required_ | The ID for the forecast you want to delete |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

List all forecasts
------------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/1931/forecasts" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer l3Y3a8-DD6Bn6xHqTeTG6L2ejEQX72RIk0iPFc_3JxQ" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/forecasts`

```
GET /1.1/1931/forecasts
Accept: application/json
Content-Type: application/json
Authorization: Bearer l3Y3a8-DD6Bn6xHqTeTG6L2ejEQX72RIk0iPFc_3JxQ
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the forecasts you want to retrieve |
| since | Specifies the start date for returned results. Example: since=2014-08-18 |
| upto | Specifies the end date for returned results. Example: upto=2014-08-24 |
| forecast_ids | Specifies the forecasts for which you want results. Numerical forecast IDs should separated by a comma, like so: "forecast_ids": "175551,117861" |
| user_ids | Specifies the users for which you want results. Numerical user IDs should separated by a comma, like so: "user_ids": "175551,117861" |
| project_ids | Specifies the projects for which you want results. Numerical project IDs should be separated by a comma, like so: "project_ids": "1751,1171" |
| page | Page number (Default 1) |
| per_page | Records per page (Default 50) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 236,
    "note": "title",
    "title": "title",
    "description": null,
    "from": "2025-06-30",
    "to": "2025-07-06",
    "user": {
      "id": 4918,
      "email": "quentinodtkhgsd@timelyapp.com",
      "name": "Quintin Duponde",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/3b9ccedf63b212943d02990d1ab0dc80?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/3b9ccedf63b212943d02990d1ab0dc80?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/3b9ccedf63b212943d02990d1ab0dc80?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/3b9ccedf63b212943d02990d1ab0dc80?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/3b9ccedf63b212943d02990d1ab0dc80?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:47:11+02:00",
      "estimated_minutes": 360,
      "estimated_duration": {
        "hours": 6,
        "minutes": 0,
        "seconds": 0,
        "formatted": "06:00",
        "total_hours": 6.0,
        "total_seconds": 21600,
        "total_minutes": 360
      },
      "weekly_capacity": 40.0,
      "work_days": "MON,TUE,WED,THU,FRI",
      "weekdays": "MO,TU,WE,TH,FR"
    },
    "users": [
      {
        "id": 4916,
        "email": "marijajqethdei@timelyapp.com",
        "name": "Marija Petrovic",
        "avatar": {
          "large_retina": "https://www.gravatar.com/avatar/190fea3e5ad65674175a3e820d7e37f9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
          "large": "https://www.gravatar.com/avatar/190fea3e5ad65674175a3e820d7e37f9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
          "medium_retina": "https://www.gravatar.com/avatar/190fea3e5ad65674175a3e820d7e37f9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
          "medium": "https://www.gravatar.com/avatar/190fea3e5ad65674175a3e820d7e37f9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
          "timeline": "https://www.gravatar.com/avatar/190fea3e5ad65674175a3e820d7e37f9?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
        },
        "updated_at": "2025-07-03T06:47:11+02:00",
        "estimated_minutes": 0,
        "estimated_duration": {
          "hours": 0,
          "minutes": 0,
          "seconds": 0,
          "formatted": "00:00",
          "total_hours": 0.0,
          "total_seconds": 0,
          "total_minutes": 0
        },
        "weekly_capacity": 40.0,
        "work_days": "MON,TUE,WED,THU,FRI",
        "weekdays": "MO,TU,WE,TH,FR"
      }
    ],
    "project": {
      "id": 1962,
      "active": true,
      "name": "Timely",
      "color": "67a3bc",
      "client": {
        "id": 1426,
        "name": "Placeat praesentium qui ad.",
        "color": "00796b",
        "active": true,
        "external_id": null,
        "updated_at": "2025-07-03T06:47:11+02:00"
      },
      "updated_at": "2025-07-03T06:47:11+02:00"
    },
    "estimated_minutes": 360,
    "updated_at": "2025-07-03T06:47:11+02:00",
    "created_at": "2025-07-03T06:47:11+02:00",
    "label_ids": [],
    "estimated_duration": {
      "hours": 6,
      "minutes": 0,
      "seconds": 0,
      "formatted": "06:00",
      "total_hours": 6.0,
      "total_seconds": 21600,
      "total_minutes": 360
    },
    "planned_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "logged_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "completed": false,
    "completed_at": null,
    "manage": true,
    "external_id": null,
    "parent_title": null
  }
]
```

Update a forecast
-----------------

### Request

```
curl "https://api.timelyapp.com/1.1/1932/forecasts/237" -d '{"forecast":{"from":"2022-05-10","to":"2022-05-16","estimated_minutes":30,"users":[{"id":4919}],"project_id":1963,"title":"new title"}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer o66QOAs6DGiQsMsHkVz9ilQiinmcnDPyRip7h5QH9Zg" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/forecasts/:id`

```
PUT /1.1/1932/forecasts/237
Accept: application/json
Content-Type: application/json
Authorization: Bearer o66QOAs6DGiQsMsHkVz9ilQiinmcnDPyRip7h5QH9Zg
```

#### Parameters

```
{"forecast":{"from":"2022-05-10","to":"2022-05-16","estimated_minutes":30,"users":[{"id":4919}],"project_id":1963,"title":"new title"}}
```

| Name | Description |
| --- | --- |
| id _required_ | Forecast ID |
| estimated_minutes _required_ | Forecast minutes |
| title | Specifies title for a forecast |
| from | Specifies the “from” time in a timestamp. Example values: from: "2022-05-26T10:00:00+05:30" |
| to | Specifies the “to” time in a timestamp. Example values: to: "2022-05-26T12:00:00+05:30" |
| users | Forecast assignees. Example values: [{ id: 1 }, { id: 3 }] |
| project_id _required_ | The numerical ID of the desired project. Example values: 123 |
| label_ids | Specifies label IDs for a forecast. Example values: label_ids:[2,3,4] |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 237,
  "note": "new title",
  "title": "new title",
  "description": "",
  "from": "2022-05-10",
  "to": "2022-05-16",
  "user": {
    "id": 4919,
    "email": "marijaakxhnmat@timelyapp.com",
    "name": "Marija Petrovic",
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
      "medium_retina": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
      "timeline": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
    },
    "updated_at": "2025-07-03T06:47:11+02:00",
    "estimated_minutes": 30,
    "estimated_duration": {
      "hours": 0,
      "minutes": 30,
      "seconds": 0,
      "formatted": "00:30",
      "total_hours": 0.5,
      "total_seconds": 1800,
      "total_minutes": 30
    },
    "weekly_capacity": 40.0,
    "work_days": "MON,TUE,WED,THU,FRI",
    "weekdays": "MO,TU,WE,TH,FR"
  },
  "users": [
    {
      "id": 4919,
      "email": "marijaakxhnmat@timelyapp.com",
      "name": "Marija Petrovic",
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/2f970b3ed279fbf57f7028afe1f29216?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "updated_at": "2025-07-03T06:47:11+02:00",
      "estimated_minutes": 0,
      "estimated_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "weekly_capacity": 40.0,
      "work_days": "MON,TUE,WED,THU,FRI",
      "weekdays": "MO,TU,WE,TH,FR"
    }
  ],
  "project": {
    "id": 1963,
    "active": true,
    "name": "Timely",
    "color": "67a3bc",
    "client": {
      "id": 1427,
      "name": "Aut recusandae cumque consequuntur.",
      "color": "2e7d32",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:12+02:00"
    },
    "updated_at": "2025-07-03T06:47:12+02:00"
  },
  "estimated_minutes": 30,
  "updated_at": "2025-07-03T06:47:12+02:00",
  "created_at": "2025-07-03T06:47:12+02:00",
  "label_ids": [],
  "estimated_duration": {
    "hours": 0,
    "minutes": 30,
    "seconds": 0,
    "formatted": "00:30",
    "total_hours": 0.5,
    "total_seconds": 1800,
    "total_minutes": 30
  },
  "planned_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "logged_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "completed": false,
  "completed_at": null,
  "manage": true,
  "external_id": null,
  "parent_title": "new title"
}
```

Labels
------

Labels (AKA Tags) help you classify work, group related tasks and require certain information for events. This API lets you to create, list, update and delete tags created on an account.

Create a label
--------------

### Request

```
curl "https://api.timelyapp.com/1.1/1970/labels" -d '{"name":null,"label":{"name":"Web Programming","active":true}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 7-mhIkzqOGa5irtG4ZdvJaxJwuVe33Y07SpA3nJwg1E" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/labels`

```
POST /1.1/1970/labels
Accept: application/json
Content-Type: application/json
Authorization: Bearer 7-mhIkzqOGa5irtG4ZdvJaxJwuVe33Y07SpA3nJwg1E
```

#### Parameters

```
{"name":null,"label":{"name":"Web Programming","active":true}}
```

| Name | Description |
| --- | --- |
| name _required_ | Specifies the label name |
| emoji | Specifies the emoji url for a label |
| parent_id | Set a parent_id if you want to create a child label |
| active | Example values: "true" or "false". Using "false" changes the label state to "archived" |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 181,
  "name": "Web Programming",
  "sequence": 1,
  "parent_id": null,
  "emoji": "https://emoji.memorycdn.com/tw64/1f3f7-fe0f.png",
  "active": true,
  "created_at": "2025-07-03T06:47:17+02:00",
  "updated_at": "2025-07-03T06:47:17+02:00",
  "children": []
}
```

Delete a label
--------------

### Request

```
curl "https://api.timelyapp.com/1.1/1971/labels/182" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer pCFibBrAboCM6HC1VmUPyvXO2HZ31fYx9qbs7WK8g44" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/labels/:id`

```
DELETE /1.1/1971/labels/182
Accept: application/json
Content-Type: application/json
Authorization: Bearer pCFibBrAboCM6HC1VmUPyvXO2HZ31fYx9qbs7WK8g44
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the label you want to delete |
| id | The ID of the label you want to delete |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

List all child labels
---------------------

Get the children of any tag on a user’s account.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1974/labels?parent_id=184" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer bSSOS7p2Me1hLkUcblVqfJaWNKW1EfIvzZP_259Y7Bc" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/labels`

```
GET /1.1/1974/labels?parent_id=184
Accept: application/json
Content-Type: application/json
Authorization: Bearer bSSOS7p2Me1hLkUcblVqfJaWNKW1EfIvzZP_259Y7Bc
```

#### Parameters

```
parent_id: 184
```

| Name | Description |
| --- | --- |
| account_id | The account ID containing the label you want to. retrieve |
| parent_id | The parent ID whose children you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 184,
  "name": "Web Programming",
  "sequence": 1,
  "parent_id": null,
  "emoji": null,
  "active": true,
  "created_at": "2025-07-03T06:47:19+02:00",
  "updated_at": "2025-07-03T06:47:19+02:00",
  "children": []
}
```

List all labels
---------------

Get all the tags present in user’s account.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1973/labels" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer JrahaEpbmaNx8W1RQgt83Xvmd8sYv42HC9mp8h5qESY" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/labels`

```
GET /1.1/1973/labels
Accept: application/json
Content-Type: application/json
Authorization: Bearer JrahaEpbmaNx8W1RQgt83Xvmd8sYv42HC9mp8h5qESY
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the label you want to. retrieve |
| offset | Retrieve labels from offset |
| limit | Retrieve number of labels |
| filter | Specifies which records to retrieve. The default shows a current workspace’s all labels (filter=all). Example: "filter=all" or "filter=active" or "filter=archived" |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[]
```

Retrieve a label
----------------

Get single tags present in user’s account.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1972/labels/183" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer fiKxDnfxYUasUxkSNPcYRz33sgRjZpY2LqMiHROrnTg" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/labels/:id`

```
GET /1.1/1972/labels/183
Accept: application/json
Content-Type: application/json
Authorization: Bearer fiKxDnfxYUasUxkSNPcYRz33sgRjZpY2LqMiHROrnTg
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the label you want to. retrieve |
| id | The ID of the label you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 183,
  "name": "Web Programming",
  "sequence": 1,
  "parent_id": null,
  "emoji": null,
  "active": true,
  "created_at": "2025-07-03T06:47:18+02:00",
  "updated_at": "2025-07-03T06:47:18+02:00",
  "children": []
}
```

Update a label
--------------

### Request

```
curl "https://api.timelyapp.com/1.1/1975/labels/185" -d '{"name":null,"label":{"name":"updated name"}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer D09b0QGT_lfElFkdMEk8zUJ8MjnFBE1ClvQMApb0Vwo" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/labels/:id`

```
PUT /1.1/1975/labels/185
Accept: application/json
Content-Type: application/json
Authorization: Bearer D09b0QGT_lfElFkdMEk8zUJ8MjnFBE1ClvQMApb0Vwo
```

#### Parameters

```
{"name":null,"label":{"name":"updated name"}}
```

| Name | Description |
| --- | --- |
| id _required_ | Label ID |
| name _required_ | Specifies the label name |
| emoji | Specifies the emoji url for a tag |
| parent_id | Set a parent_id if you want to create a child label |
| active | Example values: "true" or "false". Using "false" changes the label state to "archived" |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 185,
  "name": "updated name",
  "sequence": 1,
  "parent_id": null,
  "emoji": "https://emoji.memorycdn.com/tw64/1f3f7-fe0f.png",
  "active": true,
  "created_at": "2025-07-03T06:47:19+02:00",
  "updated_at": "2025-07-03T06:47:19+02:00",
  "children": []
}
```

Permissions
-----------

Retrieve current user's permissions
-----------------------------------

Using the account id one can see the currently logged user's permissions

### Request

```
curl -g "https://api.timelyapp.com/1.1/1986/users/current/permissions" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer rgKK6BwSSCWazxrXezQGnglya7h_sGQ7lyqS5TTD1yY" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/current/permissions`

```
GET /1.1/1986/users/current/permissions
Accept: application/json
Content-Type: application/json
Authorization: Bearer rgKK6BwSSCWazxrXezQGnglya7h_sGQ7lyqS5TTD1yY
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | Account id for which current user's permissions are to be retrieved |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "resource": "account",
    "permissions": [
      "create",
      "read",
      "update",
      "manage_plan",
      "manage_subscriptions",
      "manage_dev"
    ]
  },
  {
    "resource": "company",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "day_property",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "forecast",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "invoice",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "label",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "project",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "report",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "team",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "user",
    "permissions": [
      "create",
      "delete",
      "notify",
      "read",
      "update"
    ]
  }
]
```

Retrieve user's permissions by id
---------------------------------

Using the account id and user id one can see a specific user's permissions

### Request

```
curl -g "https://api.timelyapp.com/1.1/1987/users/5027/permissions" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 0NcbV08vZ1jZQR3DSbbI0mi7f9-Ga5nSbKOGsYJWxOY" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/:user_id/permissions`

```
GET /1.1/1987/users/5027/permissions
Accept: application/json
Content-Type: application/json
Authorization: Bearer 0NcbV08vZ1jZQR3DSbbI0mi7f9-Ga5nSbKOGsYJWxOY
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | Account for which user's permissions are required |
| user_id | User whose permissions are required |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "resource": "account",
    "permissions": [
      "create",
      "read",
      "update",
      "manage_plan",
      "manage_subscriptions",
      "manage_dev"
    ]
  },
  {
    "resource": "company",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "day_property",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "forecast",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "invoice",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "label",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "project",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "report",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "team",
    "permissions": [
      "create",
      "delete",
      "read",
      "update"
    ]
  },
  {
    "resource": "user",
    "permissions": [
      "create",
      "delete",
      "notify",
      "read",
      "update"
    ]
  }
]
```

Projects
--------

Projects contain all the project details on an account. With this API, you can retrieve, update, create or delete a specific project, or list all projects.

Create a project
----------------

### Request

```
curl "https://api.timelyapp.com/1.1/1993/projects" -d '{"project":{"name":"New Project","rate_type":"project","hour_rate":50.0,"active":true,"deleted":false,"currency_code":"usd","color":"67a3bc","enable_labels":"all","lock_hours_in":0,"description":"Project Description","client_id":1470,"budget_type":"M","budget":300,"users":[{"user_id":5039}],"budget_recurrence":{"recur":"week","start_date":"2018-09-21","end_date":"2019-09-21","recur_until":"end_date"},"labels":[{"label_id":186,"required":true},{"label_id":187,"required":true},{"label_id":188,"required":false},{"label_id":189,"required":false}]},"name":null}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer WBd6zeswDTyF2iFSvmT6RhEhbtaThgUMZdMZ6Wnxsmk" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/projects`

```
POST /1.1/1993/projects
Accept: application/json
Content-Type: application/json
Authorization: Bearer WBd6zeswDTyF2iFSvmT6RhEhbtaThgUMZdMZ6Wnxsmk
```

#### Parameters

```
{"project":{"name":"New Project","rate_type":"project","hour_rate":50.0,"active":true,"deleted":false,"currency_code":"usd","color":"67a3bc","enable_labels":"all","lock_hours_in":0,"description":"Project Description","client_id":1470,"budget_type":"M","budget":300,"users":[{"user_id":5039}],"budget_recurrence":{"recur":"week","start_date":"2018-09-21","end_date":"2019-09-21","recur_until":"end_date"},"labels":[{"label_id":186,"required":true},{"label_id":187,"required":true},{"label_id":188,"required":false},{"label_id":189,"required":false}]},"name":null}
```

| Name | Description |
| --- | --- |
| project _required_ | Project attributes |
| name _required_ | Specifies the project name |
| color | Specifies the project color. Example values: 1976d2, 00796b, 2e7d32, d4e157, ffeb3b, ffb74d, ff8a65, e57373, b72367, 7e57c2 (when omitted, the client color for the project will be used) |
| client_id _required_ | Specifies the numerical client ID |
| users _required_ | Specifies the project users. It should be an array of users, with numerical user IDs and an hour_rate. For example: "users": [{ "user_id": 175551, "hour_rate": 25.0 },{ "user_id": 117861, "hour_rate": 27.0 }] |
| rate_type _required_ | Specifies the hourly rate type for the project. It should be “user” or “project” |
| billable | Specifies whether the project is billable or not. It should be “true” or “false” |
| budget | Specifies the budget for the project. It should be numeric value |
| hour_rate | Specifies the hourly rate for the project. It should be numeric valu |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| budget_recurrence | Specifies when a recurring budget will refresh |
| send_invite | Specifies if you want to send a project invite email. It should be “true” or “false” |
| required_notes | Project hours notes to be required for logging |
| required_labels | Project hours with atleast one label to be required for logging |
| labels | Specifies the project labels, should be array of labels with numerical label id and required flag Example: "labels": [{ "label_id": 1, "required": true }, { "label_id": 2, "required": false }] |
| enable_labels | Specifies the way labels will be allowed for logging for the project. It should be “all”, “none” or “custom” |
| invoice_by_budget | Specifies if the project's invoices are based on its budget instead of hours. It should be “true“ or “false“ |
| team_ids | Specifies the project teams, should be array of numerical team id's. Example values: team_ids: [3,4,2] |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 1996,
  "active": true,
  "account_id": 1993,
  "name": "New Project",
  "description": "Project Description",
  "color": "67a3bc",
  "rate_type": "project",
  "billable": true,
  "created_at": 1751518042,
  "updated_at": 1751518042,
  "external_id": null,
  "budget_scope": null,
  "client": {
    "id": 1470,
    "name": "Mollitia repellendus nisi laudantium.",
    "color": "ffeb3b",
    "active": true,
    "external_id": null,
    "updated_at": "2025-07-03T06:47:22+02:00"
  },
  "required_notes": false,
  "required_labels": false,
  "budget_expired_on": null,
  "has_recurrence": true,
  "enable_labels": "all",
  "default_labels": false,
  "currency": {
    "id": "usd",
    "name": "United States Dollar",
    "iso_code": "USD",
    "symbol": "$",
    "symbol_first": true
  },
  "team_ids": [],
  "budget": 300,
  "budget_type": "M",
  "budget_calculation": "completed",
  "hour_rate": 50.0,
  "hour_rate_in_cents": 5000.0,
  "budget_progress": 0.0,
  "budget_percent": 0.0,
  "invoice_by_budget": false,
  "users": [
    {
      "user_id": 5039,
      "hour_rate": 50.0,
      "hour_rate_in_cents": 5000.0,
      "updated_at": "2025-07-03T06:47:22+02:00",
      "created_at": "2025-07-03T06:47:22+02:00",
      "deleted": false,
      "internal_hour_rate": 0,
      "internal_hour_rate_in_cents": 0
    }
  ],
  "labels": [
    {
      "project_id": 1996,
      "label_id": 186,
      "budget": 0,
      "required": true,
      "default": false,
      "updated_at": "2025-07-03T10:17:22+05:30"
    },
    {
      "project_id": 1996,
      "label_id": 187,
      "budget": 0,
      "required": true,
      "default": false,
      "updated_at": "2025-07-03T10:17:22+05:30"
    },
    {
      "project_id": 1996,
      "label_id": 188,
      "budget": 0,
      "required": false,
      "default": false,
      "updated_at": "2025-07-03T10:17:22+05:30"
    },
    {
      "project_id": 1996,
      "label_id": 189,
      "budget": 0,
      "required": false,
      "default": false,
      "updated_at": "2025-07-03T10:17:22+05:30"
    }
  ],
  "label_ids": [
    186,
    187,
    188,
    189
  ],
  "required_label_ids": [
    186,
    187
  ],
  "default_label_ids": [],
  "cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "estimated_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "billed_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "billed_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "unbilled_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "unbilled_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "first_logged_on": null,
  "last_logged_on": null,
  "budget_recurrence": {
    "recur": "week",
    "start_date": "2018-09-21",
    "end_date": "2019-09-21",
    "recur_until": "end_date",
    "days_count": 365,
    "updated_at": "2025-07-03T06:47:22+02:00"
  },
  "created_from": "Timely"
}
```

Delete a project
----------------

### Request

```
curl "https://api.timelyapp.com/1.1/1994/projects/1997" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer G3SfVC7GfxU0TwK2yL2EPbJcEN46xHKXmNPdUPwCq0o" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/projects/:id`

```
DELETE /1.1/1994/projects/1997
Accept: application/json
Content-Type: application/json
Authorization: Bearer G3SfVC7GfxU0TwK2yL2EPbJcEN46xHKXmNPdUPwCq0o
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the project you want to delete |
| id | The ID of the project you want to delete |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

List all projects
-----------------

Note: Admin users can access all projects on an account. Other users can only access the projects they belong to.

Project lists will return your 10000 most recently updated projects. Additionally, you can add the “limit”, “filter (deprecated)”, ”state”, ”relation”, ”sort” and “order” optional parameters to change the result.

### Request

```
curl -g "https://api.timelyapp.com/1.1/1996/projects" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer BqZwHG1jjK230FA481rpuzg5g6b7SFK9nY08fRQp83w" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/projects`

```
GET /1.1/1996/projects
Accept: application/json
Content-Type: application/json
Authorization: Bearer BqZwHG1jjK230FA481rpuzg5g6b7SFK9nY08fRQp83w
```

#### Parameters

| Name | Description |
| --- | --- |
| offset | Retrieve projects from offset |
| limit | Retrieve number of projects |
| sort | Field to sort projects by - updated_at, id, name (Default updated_at) |
| order | Sorting order - desc, asc (Default desc) |
| filter | 🚨 Deprecated: Filter projects - mine, active, archived, all (Default mine, ignored if state or relation parameter is present) |
| state | Filter projects - active, archived, all |
| relation | Filter projects - assigned, created, all |
| updated_after | Retrieve records updated after a certain timestamp |
| project_ids | Retrieve specific projects |
| external_ids | Retrieve specific projects by external ID reference |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 1999,
    "active": true,
    "account_id": 1996,
    "name": "Timely",
    "description": "Project Description",
    "color": "67a3bc",
    "rate_type": "project",
    "billable": true,
    "created_at": 1751518043,
    "updated_at": 1751518043,
    "external_id": null,
    "budget_scope": null,
    "client": {
      "id": 1473,
      "name": "Odit et tempore consequuntur.",
      "color": "00796b",
      "active": true,
      "external_id": null,
      "updated_at": "2025-07-03T06:47:23+02:00"
    },
    "required_notes": false,
    "required_labels": false,
    "budget_expired_on": null,
    "has_recurrence": false,
    "enable_labels": "all",
    "default_labels": false,
    "currency": {
      "id": "usd",
      "name": "United States Dollar",
      "iso_code": "USD",
      "symbol": "$",
      "symbol_first": true
    },
    "team_ids": [],
    "budget": 0,
    "budget_type": "",
    "budget_calculation": "completed",
    "hour_rate": 50.0,
    "hour_rate_in_cents": 5000.0,
    "budget_progress": 0.0,
    "budget_percent": 0.0,
    "invoice_by_budget": false,
    "users": [
      {
        "user_id": 5045,
        "hour_rate": 100.0,
        "hour_rate_in_cents": 10000.0,
        "updated_at": "2025-07-03T06:47:23+02:00",
        "created_at": "2025-07-03T06:47:23+02:00",
        "deleted": false,
        "internal_hour_rate": 0,
        "internal_hour_rate_in_cents": 0
      }
    ],
    "labels": [],
    "label_ids": [],
    "required_label_ids": [],
    "default_label_ids": [],
    "cost": {
      "fractional": 0,
      "formatted": "$0.00",
      "amount": 0.0,
      "currency_code": "usd"
    },
    "estimated_cost": {
      "fractional": 0,
      "formatted": "$0.00",
      "amount": 0.0,
      "currency_code": "usd"
    },
    "duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "estimated_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "billed_cost": {
      "fractional": 0,
      "formatted": "$0.00",
      "amount": 0.0,
      "currency_code": "usd"
    },
    "billed_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "unbilled_cost": {
      "fractional": 0,
      "formatted": "$0.00",
      "amount": 0.0,
      "currency_code": "usd"
    },
    "unbilled_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "created_from": "Web"
  }
]
```

Retrieve a project Retrieve a single project by using its ID.
-------------------------------------------------------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/1995/projects/1998" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer dKkIk1QHVwyCtci2WuVKr6NL_AsDBj3AM_JmJZR-Efo" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/projects/:id`

```
GET /1.1/1995/projects/1998
Accept: application/json
Content-Type: application/json
Authorization: Bearer dKkIk1QHVwyCtci2WuVKr6NL_AsDBj3AM_JmJZR-Efo
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the project you want to retrieve |
| id | The ID of the project you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 1998,
  "active": true,
  "account_id": 1995,
  "name": "Timely",
  "description": "Project Description",
  "color": "67a3bc",
  "rate_type": "project",
  "billable": true,
  "created_at": 1751518042,
  "updated_at": 1751518042,
  "external_id": null,
  "budget_scope": null,
  "client": {
    "id": 1472,
    "name": "Soluta eum eius eum.",
    "color": "ffb74d",
    "active": true,
    "external_id": null,
    "updated_at": "2025-07-03T06:47:22+02:00"
  },
  "required_notes": false,
  "required_labels": false,
  "budget_expired_on": null,
  "has_recurrence": false,
  "enable_labels": "all",
  "default_labels": false,
  "currency": {
    "id": "usd",
    "name": "United States Dollar",
    "iso_code": "USD",
    "symbol": "$",
    "symbol_first": true
  },
  "team_ids": [],
  "budget": 0,
  "budget_type": "",
  "budget_calculation": "completed",
  "hour_rate": 50.0,
  "hour_rate_in_cents": 5000.0,
  "budget_progress": 0.0,
  "budget_percent": 0.0,
  "invoice_by_budget": false,
  "users": [
    {
      "user_id": 5043,
      "hour_rate": 100.0,
      "hour_rate_in_cents": 10000.0,
      "updated_at": "2025-07-03T06:47:22+02:00",
      "created_at": "2025-07-03T06:47:22+02:00",
      "deleted": false,
      "internal_hour_rate": 0,
      "internal_hour_rate_in_cents": 0
    }
  ],
  "labels": [],
  "label_ids": [],
  "required_label_ids": [],
  "default_label_ids": [],
  "cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "estimated_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "billed_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "billed_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "unbilled_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "unbilled_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "first_logged_on": null,
  "last_logged_on": null,
  "locked_hours": false,
  "created_from": "Web"
}
```

Update a project
----------------

### Request

```
curl "https://api.timelyapp.com/1.1/1998/projects/2001" -d '{"project":{"name":"updated project name","name":null}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer jHVoKmLgESckOci1-_I7Q8l1YDPYNi0mCJZvpF7w9ZQ" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/projects/:id`

```
PUT /1.1/1998/projects/2001
Accept: application/json
Content-Type: application/json
Authorization: Bearer jHVoKmLgESckOci1-_I7Q8l1YDPYNi0mCJZvpF7w9ZQ
```

#### Parameters

```
{"project":{"name":"updated project name","name":null}}
```

| Name | Description |
| --- | --- |
| id _required_ | Project ID |
| project | Project attributes |
| project[name] _required_ | Specifies the project name |
| project[active] | Example values: “true” or “false”. Using “false” changes the project state to “archived” |
| project[color] | Specifies the project color (when omitted, the client color for the project will be used) |
| project[client_id] _required_ | Specifies the numerical client ID |
| project[users] _required_ | Specifies the project users. It should be an array of users, with numerical user IDs and an hour_rate. For example: "users": [{ "user_id": 175551, "hour_rate": 25.0 },{ "user_id": 117861, "hour_rate": 27.0 }] |
| project[billable] | Specifies whether the project is billable or not. It should be “true” or “false” |
| project[budget] | Specifies the budget for the project. It should be numeric value |
| project[hour_rate] | Specifies the hourly rate for the project. It should be numeric value |
| project[rate_type] | Specifies the hourly rate type for the project. It should be “user” or “project” |
| project[external_id] | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| project[send_invite] | Specifies if you want to send a project invite email. It should be “true” or “false” |
| project[required_notes] | Project hours notes to be required for logging |
| project[required_labels] | Project hours with atleast one label to be required for logging |
| project[enable_labels] | Specifies the way labels will be allowed for logging the project. It should be “all”, “none” or “custom” |
| project[invoice_by_budget] | Specifies if the project's invoices are based on its budget instead of hours. It should be “true“ or “false“. |
| update_existing_hours | Specifies if the rates of existing hours in the project should be updated. It should be "true" or "false". Default: true |
| update_unbilled_only | Specifies if only the rates of unbilled hours in the project should be updated. It is ignored if "update_existing_hours" is false. It should be "true" or "false". Default: false |
| team_ids | Specifies the project teams, should be array of numerical team id's. Example values: team_ids: [3,4,2] |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 2001,
  "active": true,
  "account_id": 1998,
  "name": "Timely",
  "description": "Project Description",
  "color": "67a3bc",
  "rate_type": "project",
  "billable": true,
  "created_at": 1751518043,
  "updated_at": 1751518043,
  "external_id": null,
  "budget_scope": null,
  "client": {
    "id": 1475,
    "name": "Corporis fugiat ea quod.",
    "color": "d4e157",
    "active": true,
    "external_id": null,
    "updated_at": "2025-07-03T06:47:23+02:00"
  },
  "required_notes": false,
  "required_labels": false,
  "budget_expired_on": null,
  "has_recurrence": false,
  "enable_labels": "none",
  "default_labels": false,
  "currency": {
    "id": "usd",
    "name": "United States Dollar",
    "iso_code": "USD",
    "symbol": "$",
    "symbol_first": true
  },
  "team_ids": [],
  "budget": 0,
  "budget_type": "",
  "budget_calculation": "pending",
  "hour_rate": 50.0,
  "hour_rate_in_cents": 5000.0,
  "budget_progress": 0.0,
  "budget_percent": 0.0,
  "invoice_by_budget": false,
  "users": [
    {
      "user_id": 5049,
      "hour_rate": 50.0,
      "hour_rate_in_cents": 5000.0,
      "updated_at": "2025-07-03T06:47:23+02:00",
      "created_at": "2025-07-03T06:47:23+02:00",
      "deleted": false,
      "internal_hour_rate": 0,
      "internal_hour_rate_in_cents": 0
    }
  ],
  "labels": [],
  "label_ids": [],
  "required_label_ids": [],
  "default_label_ids": [],
  "cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "estimated_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "estimated_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "billed_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "billed_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "unbilled_cost": {
    "fractional": 0,
    "formatted": "$0.00",
    "amount": 0.0,
    "currency_code": "usd"
  },
  "unbilled_duration": {
    "hours": 0,
    "minutes": 0,
    "seconds": 0,
    "formatted": "00:00",
    "total_hours": 0.0,
    "total_seconds": 0,
    "total_minutes": 0
  },
  "first_logged_on": null,
  "last_logged_on": null,
  "created_from": "Web"
}
```

Reports
-------

Report on activity across your business, including individual and team performance. Export report data from JSON to a format of your choice. Note: .XLS, .CSV and .PDF report formats can only be downloaded from the web UI, not the API.

All Reports For a normal user accessing all account reports.
------------------------------------------------------------

Note:

1) If start_date and end_date parameters are not passed, the period will default to the beginning-to-end of a month. 2) If user and project parameters are not passed, by default a normal user will get all reports on an account, and a limited user will only get reports they have created. 3) Only normal users can access reports created by other users on an account. Limited users can only access reports they have created. 4) Only normal users can access reports for other projects on an account. Limited users can only access reports for projects they have created.

### Request

```
curl "https://api.timelyapp.com/1.1/2040/reports" -d '{"user_ids":"5172","since":"2018-01-01","until":"2019-01-01","project_ids":"2104"}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer UNCXRc7LVAOLz5tJBUKTcbH__FSMG-CX1RSW5sU65VE" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/reports`

```
POST /1.1/2040/reports
Accept: application/json
Content-Type: application/json
Authorization: Bearer UNCXRc7LVAOLz5tJBUKTcbH__FSMG-CX1RSW5sU65VE
```

#### Parameters

```
{"user_ids":"5172","since":"2018-01-01","until":"2019-01-01","project_ids":"2104"}
```

| Name | Description |
| --- | --- |
| account_id | The account ID containing the report you want to retrieve |
| user_ids | Specifies the users for which you want reports. Numerical user IDs should separated by a comma, like so: "user_ids": "175551,117861" |
| since | Specifies the start date for a report: For example: "since" : "Jan 01, 2014" |
| until | Specifies the end date for a report. For example: "until" : "Dec 31, 2014" |
| project_ids | Specifies the projects for which you want reports. Numerical project IDs should be separated by a comma, like so: "project_ids": "1751,1171" |
| billed | Specifies whether you want to report to show estimated or billed events. For example: "billed": false or "billed": true |
| label_ids | Specifies the labels pertaining to a report you want to see. Numerical label IDs should be separated by a comma, like so: "label_ids": [751,117] or "751,117". Result will include any of provided values. |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 1517,
    "name": "Voluptate asperiores non repudiandae.",
    "projects": [
      {
        "id": 2104,
        "active": true,
        "account_id": 2040,
        "name": "Timely",
        "description": "Project Description",
        "color": "67a3bc",
        "rate_type": "project",
        "billable": true,
        "created_at": 1751518060,
        "updated_at": 1751518060,
        "external_id": null,
        "budget_scope": null,
        "client": {
          "id": 1517,
          "name": "Voluptate asperiores non repudiandae.",
          "color": "d4e157",
          "active": true,
          "external_id": null,
          "updated_at": "2025-07-03T06:47:40+02:00"
        },
        "required_notes": false,
        "required_labels": false,
        "budget_expired_on": null,
        "has_recurrence": false,
        "enable_labels": "all",
        "default_labels": false,
        "currency": {
          "id": "usd",
          "name": "United States Dollar",
          "iso_code": "USD",
          "symbol": "$",
          "symbol_first": true
        },
        "team_ids": [],
        "budget": 0,
        "budget_type": "",
        "budget_calculation": "completed",
        "hour_rate": 50.0,
        "hour_rate_in_cents": 5000.0,
        "budget_progress": 0.0,
        "budget_percent": 0.0,
        "invoice_by_budget": false,
        "duration": {
          "hours": 5,
          "minutes": 0,
          "seconds": 0,
          "formatted": "05:00",
          "total_hours": 5.0,
          "total_seconds": 18000,
          "total_minutes": 300
        },
        "estimated_duration": {
          "hours": 8,
          "minutes": 0,
          "seconds": 0,
          "formatted": "08:00",
          "total_hours": 8.0,
          "total_seconds": 28800,
          "total_minutes": 480
        },
        "billed_duration": {
          "hours": 0,
          "minutes": 0,
          "seconds": 0,
          "formatted": "00:00",
          "total_hours": 0.0,
          "total_seconds": 0,
          "total_minutes": 0
        },
        "unbilled_duration": {
          "hours": 5,
          "minutes": 0,
          "seconds": 0,
          "formatted": "05:00",
          "total_hours": 5.0,
          "total_seconds": 18000,
          "total_minutes": 300
        },
        "billable_duration": {
          "hours": 5,
          "minutes": 0,
          "seconds": 0,
          "formatted": "05:00",
          "total_hours": 5.0,
          "total_seconds": 18000,
          "total_minutes": 300
        },
        "non_billable_duration": {
          "hours": 0,
          "minutes": 0,
          "seconds": 0,
          "formatted": "00:00",
          "total_hours": 0.0,
          "total_seconds": 0,
          "total_minutes": 0
        },
        "cost": {
          "fractional": 50000,
          "formatted": "$500.00",
          "amount": 500.0,
          "currency_code": "usd"
        },
        "estimated_cost": {
          "fractional": 80000,
          "formatted": "$800.00",
          "amount": 800.0,
          "currency_code": "usd"
        },
        "billed_cost": {
          "fractional": 0,
          "formatted": "$0.00",
          "amount": 0.0,
          "currency_code": "usd"
        },
        "unbilled_cost": {
          "fractional": 50000,
          "formatted": "$500.00",
          "amount": 500.0,
          "currency_code": "usd"
        },
        "internal_cost": {
          "fractional": 75000,
          "formatted": "$750.00",
          "amount": 750.0,
          "currency_code": "usd"
        },
        "profit": {
          "fractional": -25000,
          "formatted": "$-250.00",
          "amount": -250.0,
          "currency_code": "usd"
        },
        "profitability": 0,
        "created_from": "Web"
      }
    ],
    "duration": {
      "hours": 5,
      "minutes": 0,
      "seconds": 0,
      "formatted": "05:00",
      "total_hours": 5.0,
      "total_seconds": 18000,
      "total_minutes": 300
    },
    "estimated_duration": {
      "hours": 8,
      "minutes": 0,
      "seconds": 0,
      "formatted": "08:00",
      "total_hours": 8.0,
      "total_seconds": 28800,
      "total_minutes": 480
    },
    "billed_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "unbilled_duration": {
      "hours": 5,
      "minutes": 0,
      "seconds": 0,
      "formatted": "05:00",
      "total_hours": 5.0,
      "total_seconds": 18000,
      "total_minutes": 300
    },
    "billable_duration": {
      "hours": 5,
      "minutes": 0,
      "seconds": 0,
      "formatted": "05:00",
      "total_hours": 5.0,
      "total_seconds": 18000,
      "total_minutes": 300
    },
    "non_billable_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "cost": {
      "fractional": 50000,
      "formatted": "$500.00",
      "amount": 500.0,
      "currency_code": "usd"
    },
    "estimated_cost": {
      "fractional": 80000,
      "formatted": "$800.00",
      "amount": 800.0,
      "currency_code": "usd"
    },
    "billed_cost": {
      "fractional": 0,
      "formatted": "$0.00",
      "amount": 0.0,
      "currency_code": "usd"
    },
    "unbilled_cost": {
      "fractional": 50000,
      "formatted": "$500.00",
      "amount": 500.0,
      "currency_code": "usd"
    },
    "internal_cost": {
      "fractional": 75000,
      "formatted": "$750.00",
      "amount": 750.0,
      "currency_code": "usd"
    },
    "profit": {
      "fractional": -25000,
      "formatted": "$-250.00",
      "amount": -250.0,
      "currency_code": "usd"
    },
    "profitability": 0
  }
]
```

Filter reports
--------------

Use filter endpoints with parameters to limit returned data, so you only see the values that you need.

### Request

```
curl "https://api.timelyapp.com/1.1/2041/reports/filter" -d '{"user_ids":"5174","since":"2018-01-01","until":"2019-01-01","project_ids":"2105"}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer J1sqQJ3BlvARkOHDsl-JDfoK-HdJDun71W9fhayk5KI" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/reports/filter`

```
POST /1.1/2041/reports/filter
Accept: application/json
Content-Type: application/json
Authorization: Bearer J1sqQJ3BlvARkOHDsl-JDfoK-HdJDun71W9fhayk5KI
```

#### Parameters

```
{"user_ids":"5174","since":"2018-01-01","until":"2019-01-01","project_ids":"2105"}
```

| Name | Description |
| --- | --- |
| billed | Retrieve billed hours only. Example: billed=true |
| label_ids | Specifies the label IDs of the hours you want to retrieve. Label IDs should be a numerical array, like so: label_ids: [3,4,2] or "3,4,2". Result will include any of provided values. |
| project_ids | Specifies the project IDs of the hours you want to retrieve. Project IDs should be a numerical array, like so: project_ids: [3,4,2] |
| since | The start date of a report. For example: 'since=2019-01-01' |
| team_ids | Specifies the team IDs of the hours you want to retrieve. Team IDs should be a numerical array, like so: team_ids: [3,4,2] |
| until | The end date of a report. For example: 'until=2019-12-31'' |
| user_ids | Specifies the user IDs of the hours you want to retrieve. User IDs should be a numerical array, like so: user_ids: [3,4,2] |
| group_by | Specifies how to group the hours. Default: group_by: ["clients", "users", "labels", "days", "teams"] |
| scope | Retrieve events only. For example: 'scope=events' |
| offset | Retrieve records from offset (Default 0). |
| limit | Retrieve number of records. Max 100 records. |
| page | Page number (Default 1). |
| locked | Retrieve locked hours only. Example: locked=true |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "multiple_currency_report": false,
  "totals": {
    "duration": {
      "hours": 5,
      "minutes": 0,
      "seconds": 0,
      "formatted": "05:00",
      "total_hours": 5.0,
      "total_seconds": 18000,
      "total_minutes": 300
    },
    "estimated_duration": {
      "hours": 8,
      "minutes": 0,
      "seconds": 0,
      "formatted": "08:00",
      "total_hours": 8.0,
      "total_seconds": 28800,
      "total_minutes": 480
    },
    "billed_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "unbilled_duration": {
      "hours": 5,
      "minutes": 0,
      "seconds": 0,
      "formatted": "05:00",
      "total_hours": 5.0,
      "total_seconds": 18000,
      "total_minutes": 300
    },
    "billable_duration": {
      "hours": 5,
      "minutes": 0,
      "seconds": 0,
      "formatted": "05:00",
      "total_hours": 5.0,
      "total_seconds": 18000,
      "total_minutes": 300
    },
    "non_billable_duration": {
      "hours": 0,
      "minutes": 0,
      "seconds": 0,
      "formatted": "00:00",
      "total_hours": 0.0,
      "total_seconds": 0,
      "total_minutes": 0
    },
    "cost": {
      "fractional": 50000,
      "formatted": "$500.00",
      "amount": 500.0,
      "currency_code": "usd"
    },
    "estimated_cost": {
      "fractional": 80000,
      "formatted": "$800.00",
      "amount": 800.0,
      "currency_code": "usd"
    },
    "billed_cost": {
      "fractional": 0,
      "formatted": "$0.00",
      "amount": 0.0,
      "currency_code": "usd"
    },
    "unbilled_cost": {
      "fractional": 50000,
      "formatted": "$500.00",
      "amount": 500.0,
      "currency_code": "usd"
    },
    "internal_cost": {
      "fractional": 75000,
      "formatted": "$750.00",
      "amount": 750.0,
      "currency_code": "usd"
    },
    "profit": {
      "fractional": -25000,
      "formatted": "$-250.00",
      "amount": -250.0,
      "currency_code": "usd"
    },
    "profitability": 0
  },
  "clients": [
    {
      "id": 1518,
      "name": "Reprehenderit possimus odit officiis.",
      "projects": [
        {
          "id": 2105,
          "active": true,
          "account_id": 2041,
          "name": "Timely",
          "description": "Project Description",
          "color": "67a3bc",
          "rate_type": "project",
          "billable": true,
          "created_at": 1751518061,
          "updated_at": 1751518061,
          "external_id": null,
          "budget_scope": null,
          "client": {
            "id": 1518,
            "name": "Reprehenderit possimus odit officiis.",
            "color": "b72367",
            "active": true,
            "external_id": null,
            "updated_at": "2025-07-03T06:47:41+02:00"
          },
          "required_notes": false,
          "required_labels": false,
          "budget_expired_on": null,
          "has_recurrence": false,
          "enable_labels": "all",
          "default_labels": false,
          "currency": {
            "id": "usd",
            "name": "United States Dollar",
            "iso_code": "USD",
            "symbol": "$",
            "symbol_first": true
          },
          "team_ids": [],
          "budget": 0,
          "budget_type": "",
          "budget_calculation": "completed",
          "hour_rate": 50.0,
          "hour_rate_in_cents": 5000.0,
          "budget_progress": 0.0,
          "budget_percent": 0.0,
          "invoice_by_budget": false,
          "duration": {
            "hours": 5,
            "minutes": 0,
            "seconds": 0,
            "formatted": "05:00",
            "total_hours": 5.0,
            "total_seconds": 18000,
            "total_minutes": 300
          },
          "estimated_duration": {
            "hours": 8,
            "minutes": 0,
            "seconds": 0,
            "formatted": "08:00",
            "total_hours": 8.0,
            "total_seconds": 28800,
            "total_minutes": 480
          },
          "billed_duration": {
            "hours": 0,
            "minutes": 0,
            "seconds": 0,
            "formatted": "00:00",
            "total_hours": 0.0,
            "total_seconds": 0,
            "total_minutes": 0
          },
          "unbilled_duration": {
            "hours": 5,
            "minutes": 0,
            "seconds": 0,
            "formatted": "05:00",
            "total_hours": 5.0,
            "total_seconds": 18000,
            "total_minutes": 300
          },
          "billable_duration": {
            "hours": 5,
            "minutes": 0,
            "seconds": 0,
            "formatted": "05:00",
            "total_hours": 5.0,
            "total_seconds": 18000,
            "total_minutes": 300
          },
          "non_billable_duration": {
            "hours": 0,
            "minutes": 0,
            "seconds": 0,
            "formatted": "00:00",
            "total_hours": 0.0,
            "total_seconds": 0,
            "total_minutes": 0
          },
          "cost": {
            "fractional": 50000,
            "formatted": "$500.00",
            "amount": 500.0,
            "currency_code": "usd"
          },
          "estimated_cost": {
            "fractional": 80000,
            "formatted": "$800.00",
            "amount": 800.0,
            "currency_code": "usd"
          },
          "billed_cost": {
            "fractional": 0,
            "formatted": "$0.00",
            "amount": 0.0,
            "currency_code": "usd"
          },
          "unbilled_cost": {
            "fractional": 50000,
            "formatted": "$500.00",
            "amount": 500.0,
            "currency_code": "usd"
          },
          "internal_cost": {
            "fractional": 75000,
            "formatted": "$750.00",
            "amount": 750.0,
            "currency_code": "usd"
          },
          "profit": {
            "fractional": -25000,
            "formatted": "$-250.00",
            "amount": -250.0,
            "currency_code": "usd"
          },
          "profitability": 0,
          "created_from": "Web"
        }
      ],
      "duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "estimated_duration": {
        "hours": 8,
        "minutes": 0,
        "seconds": 0,
        "formatted": "08:00",
        "total_hours": 8.0,
        "total_seconds": 28800,
        "total_minutes": 480
      },
      "billed_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "unbilled_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "billable_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "non_billable_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "estimated_cost": {
        "fractional": 80000,
        "formatted": "$800.00",
        "amount": 800.0,
        "currency_code": "usd"
      },
      "billed_cost": {
        "fractional": 0,
        "formatted": "$0.00",
        "amount": 0.0,
        "currency_code": "usd"
      },
      "unbilled_cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "internal_cost": {
        "fractional": 75000,
        "formatted": "$750.00",
        "amount": 750.0,
        "currency_code": "usd"
      },
      "profit": {
        "fractional": -25000,
        "formatted": "$-250.00",
        "amount": -250.0,
        "currency_code": "usd"
      },
      "profitability": 0
    }
  ],
  "users": [
    {
      "id": 5174,
      "email": "marijasnexyzip@timelyapp.com",
      "name": "Marija Petrovic",
      "time_zone": "Europe/Paris",
      "updated_at": 1751518060,
      "active": false,
      "deleted": false,
      "memory_onboarded": true,
      "day_view_onboarded": true,
      "last_received_memories_date": null,
      "date_format": "dmy",
      "time_format": "24",
      "memory_retention_days": null,
      "avatar": {
        "large_retina": "https://www.gravatar.com/avatar/0d1c364b4ffe485694497de6e3a7171c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
        "large": "https://www.gravatar.com/avatar/0d1c364b4ffe485694497de6e3a7171c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=",
        "medium_retina": "https://www.gravatar.com/avatar/0d1c364b4ffe485694497de6e3a7171c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
        "medium": "https://www.gravatar.com/avatar/0d1c364b4ffe485694497de6e3a7171c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=",
        "timeline": "https://www.gravatar.com/avatar/0d1c364b4ffe485694497de6e3a7171c?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_timeline-e61ac46443487bd24fbaecab08cfacf5d0835b371cbe97a33b9e738744ef8334.jpg&s="
      },
      "duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "estimated_duration": {
        "hours": 8,
        "minutes": 0,
        "seconds": 0,
        "formatted": "08:00",
        "total_hours": 8.0,
        "total_seconds": 28800,
        "total_minutes": 480
      },
      "billed_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "unbilled_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "billable_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "non_billable_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "estimated_cost": {
        "fractional": 80000,
        "formatted": "$800.00",
        "amount": 800.0,
        "currency_code": "usd"
      },
      "billed_cost": {
        "fractional": 0,
        "formatted": "$0.00",
        "amount": 0.0,
        "currency_code": "usd"
      },
      "unbilled_cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "internal_cost": {
        "fractional": 75000,
        "formatted": "$750.00",
        "amount": 750.0,
        "currency_code": "usd"
      },
      "profit": {
        "fractional": -25000,
        "formatted": "$-250.00",
        "amount": -250.0,
        "currency_code": "usd"
      },
      "profitability": 0,
      "capacity": {
        "hours": 2096,
        "minutes": 0,
        "seconds": 0.0,
        "formatted": "2096:00",
        "total_hours": 2096.0,
        "total_seconds": 7545600.0,
        "total_minutes": 125760.0
      },
      "overtime": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "undertime": {
        "hours": 2091,
        "minutes": 0,
        "seconds": 0.0,
        "formatted": "2091:00",
        "total_hours": 2091.0,
        "total_seconds": 7527600.0,
        "total_minutes": 125460.0
      }
    }
  ],
  "labels": [
    {
      "id": 0,
      "name": "Untagged",
      "sequence": -1,
      "parent_id": null,
      "emoji": "https://emoji.memorycdn.com/tw64/1f3f7.png",
      "active": true,
      "created_at": null,
      "updated_at": null,
      "children": [],
      "duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "estimated_duration": {
        "hours": 8,
        "minutes": 0,
        "seconds": 0,
        "formatted": "08:00",
        "total_hours": 8.0,
        "total_seconds": 28800,
        "total_minutes": 480
      },
      "billed_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "unbilled_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "billable_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "non_billable_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "estimated_cost": {
        "fractional": 80000,
        "formatted": "$800.00",
        "amount": 800.0,
        "currency_code": "usd"
      },
      "billed_cost": {
        "fractional": 0,
        "formatted": "$0.00",
        "amount": 0.0,
        "currency_code": "usd"
      },
      "unbilled_cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "internal_cost": {
        "fractional": 75000,
        "formatted": "$750.00",
        "amount": 750.0,
        "currency_code": "usd"
      },
      "profit": {
        "fractional": -25000,
        "formatted": "$-250.00",
        "amount": -250.0,
        "currency_code": "usd"
      },
      "profitability": 0
    }
  ],
  "days": [
    {
      "day": "2018-01-02",
      "duration": {
        "hours": 2,
        "minutes": 30,
        "seconds": 0,
        "formatted": "02:30",
        "total_hours": 2.5,
        "total_seconds": 9000,
        "total_minutes": 150
      },
      "estimated_duration": {
        "hours": 4,
        "minutes": 0,
        "seconds": 0,
        "formatted": "04:00",
        "total_hours": 4.0,
        "total_seconds": 14400,
        "total_minutes": 240
      },
      "billed_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "unbilled_duration": {
        "hours": 2,
        "minutes": 30,
        "seconds": 0,
        "formatted": "02:30",
        "total_hours": 2.5,
        "total_seconds": 9000,
        "total_minutes": 150
      },
      "billable_duration": {
        "hours": 2,
        "minutes": 30,
        "seconds": 0,
        "formatted": "02:30",
        "total_hours": 2.5,
        "total_seconds": 9000,
        "total_minutes": 150
      },
      "non_billable_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "cost": {
        "fractional": 25000,
        "formatted": "$250.00",
        "amount": 250.0,
        "currency_code": "usd"
      },
      "estimated_cost": {
        "fractional": 40000,
        "formatted": "$400.00",
        "amount": 400.0,
        "currency_code": "usd"
      },
      "billed_cost": {
        "fractional": 0,
        "formatted": "$0.00",
        "amount": 0.0,
        "currency_code": "usd"
      },
      "unbilled_cost": {
        "fractional": 25000,
        "formatted": "$250.00",
        "amount": 250.0,
        "currency_code": "usd"
      },
      "internal_cost": {
        "fractional": 37500,
        "formatted": "$375.00",
        "amount": 375.0,
        "currency_code": "usd"
      },
      "profit": {
        "fractional": -12500,
        "formatted": "$-125.00",
        "amount": -125.0,
        "currency_code": "usd"
      },
      "profitability": 0
    },
    {
      "day": "2018-01-01",
      "duration": {
        "hours": 2,
        "minutes": 30,
        "seconds": 0,
        "formatted": "02:30",
        "total_hours": 2.5,
        "total_seconds": 9000,
        "total_minutes": 150
      },
      "estimated_duration": {
        "hours": 4,
        "minutes": 0,
        "seconds": 0,
        "formatted": "04:00",
        "total_hours": 4.0,
        "total_seconds": 14400,
        "total_minutes": 240
      },
      "billed_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "unbilled_duration": {
        "hours": 2,
        "minutes": 30,
        "seconds": 0,
        "formatted": "02:30",
        "total_hours": 2.5,
        "total_seconds": 9000,
        "total_minutes": 150
      },
      "billable_duration": {
        "hours": 2,
        "minutes": 30,
        "seconds": 0,
        "formatted": "02:30",
        "total_hours": 2.5,
        "total_seconds": 9000,
        "total_minutes": 150
      },
      "non_billable_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "cost": {
        "fractional": 25000,
        "formatted": "$250.00",
        "amount": 250.0,
        "currency_code": "usd"
      },
      "estimated_cost": {
        "fractional": 40000,
        "formatted": "$400.00",
        "amount": 400.0,
        "currency_code": "usd"
      },
      "billed_cost": {
        "fractional": 0,
        "formatted": "$0.00",
        "amount": 0.0,
        "currency_code": "usd"
      },
      "unbilled_cost": {
        "fractional": 25000,
        "formatted": "$250.00",
        "amount": 250.0,
        "currency_code": "usd"
      },
      "internal_cost": {
        "fractional": 37500,
        "formatted": "$375.00",
        "amount": 375.0,
        "currency_code": "usd"
      },
      "profit": {
        "fractional": -12500,
        "formatted": "$-125.00",
        "amount": -125.0,
        "currency_code": "usd"
      },
      "profitability": 0
    }
  ],
  "teams": [
    {
      "id": 0,
      "name": "No team",
      "color": "866b9c",
      "emoji": "https://emoji.memorycdn.com/tw64/1f465.png",
      "external_id": null,
      "duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "estimated_duration": {
        "hours": 8,
        "minutes": 0,
        "seconds": 0,
        "formatted": "08:00",
        "total_hours": 8.0,
        "total_seconds": 28800,
        "total_minutes": 480
      },
      "billed_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "unbilled_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "billable_duration": {
        "hours": 5,
        "minutes": 0,
        "seconds": 0,
        "formatted": "05:00",
        "total_hours": 5.0,
        "total_seconds": 18000,
        "total_minutes": 300
      },
      "non_billable_duration": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "estimated_cost": {
        "fractional": 80000,
        "formatted": "$800.00",
        "amount": 800.0,
        "currency_code": "usd"
      },
      "billed_cost": {
        "fractional": 0,
        "formatted": "$0.00",
        "amount": 0.0,
        "currency_code": "usd"
      },
      "unbilled_cost": {
        "fractional": 50000,
        "formatted": "$500.00",
        "amount": 500.0,
        "currency_code": "usd"
      },
      "internal_cost": {
        "fractional": 75000,
        "formatted": "$750.00",
        "amount": 750.0,
        "currency_code": "usd"
      },
      "profit": {
        "fractional": -25000,
        "formatted": "$-250.00",
        "amount": -250.0,
        "currency_code": "usd"
      },
      "profitability": 0,
      "capacity": {
        "hours": 2096,
        "minutes": 0,
        "seconds": 0.0,
        "formatted": "2096:00",
        "total_hours": 2096.0,
        "total_seconds": 7545600.0,
        "total_minutes": 125760.0
      },
      "overtime": {
        "hours": 0,
        "minutes": 0,
        "seconds": 0,
        "formatted": "00:00",
        "total_hours": 0.0,
        "total_seconds": 0,
        "total_minutes": 0
      },
      "undertime": {
        "hours": 2091,
        "minutes": 0,
        "seconds": 0.0,
        "formatted": "2091:00",
        "total_hours": 2091.0,
        "total_seconds": 7527600.0,
        "total_minutes": 125460.0
      }
    }
  ]
}
```

Roles
-----

List roles
----------

Note: default attribute shows which role to select by default

### Request

```
curl -g "https://api.timelyapp.com/1.1/2042/roles" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer S8Cy7WKaUOpbpgpB48L777SdWN4ka4EiJZmhuc7TrBE" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/roles`

```
GET /1.1/2042/roles
Accept: application/json
Content-Type: application/json
Authorization: Bearer S8Cy7WKaUOpbpgpB48L777SdWN4ka4EiJZmhuc7TrBE
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | Account id for which roles are required |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 8165,
    "name": "admin",
    "display_name": "Admin",
    "description": "Can see, create and edit all hours, projects and teams.",
    "scopes": [
      {
        "name": "hide_hourly_rate",
        "display_name": "Hide billable rate",
        "description": "Hide hourly rates for this user",
        "default": false,
        "options": [
          false
        ]
      },
      {
        "name": "hide_internal_hourly_rate",
        "display_name": "Hide cost rate",
        "description": "Hide internal hourly rates for this user",
        "default": false,
        "options": [
          false
        ]
      }
    ],
    "default": false,
    "allowed_to_invite": true
  },
  {
    "id": 8167,
    "name": "employee",
    "display_name": "Employee",
    "description": "Can only see, log and edit their own hours.",
    "scopes": [
      {
        "name": "hide_hourly_rate",
        "display_name": "Hide billable rate",
        "description": "Hide hourly rates for this user",
        "default": false,
        "options": [
          true,
          false
        ]
      },
      {
        "name": "hide_internal_hourly_rate",
        "display_name": "Hide cost rate",
        "description": "Hide internal hourly rates for this user",
        "default": true,
        "options": [
          true,
          false
        ]
      }
    ],
    "default": false,
    "allowed_to_invite": true
  },
  {
    "id": 8166,
    "name": "manager",
    "display_name": "Manager",
    "description": "Can see, log and edit hours for anyone on the same project as them.",
    "scopes": [
      {
        "name": "hide_hourly_rate",
        "display_name": "Hide billable rate",
        "description": "Hide hourly rates for this user",
        "default": false,
        "options": [
          true,
          false
        ]
      },
      {
        "name": "hide_internal_hourly_rate",
        "display_name": "Hide cost rate",
        "description": "Hide internal hourly rates for this user",
        "default": true,
        "options": [
          true,
          false
        ]
      }
    ],
    "default": true,
    "allowed_to_invite": true
  },
  {
    "id": 8168,
    "name": "team_lead",
    "display_name": "Team Lead",
    "description": "Can see, log and edit hours for anyone from the team they lead",
    "scopes": [
      {
        "name": "hide_hourly_rate",
        "display_name": "Hide billable rate",
        "description": "Hide hourly rates for this user",
        "default": false,
        "options": [
          true,
          false
        ]
      },
      {
        "name": "hide_internal_hourly_rate",
        "display_name": "Hide cost rate",
        "description": "Hide internal hourly rates for this user",
        "default": true,
        "options": [
          true,
          false
        ]
      }
    ],
    "default": false,
    "allowed_to_invite": false
  }
]
```

Teams
-----

The team object shows all teams available on an account.

Create a team
-------------

### Request

```
curl "https://api.timelyapp.com/1.1/2065/teams" -d '{"name":null,"team":{"name":"Timely","color":"67a3bc","emoji":"http://path.to/emoji.png","external_id":null,"users":[{"user_id":5222,"lead":true},{"user_id":5224,"lead":false}]}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer tZsTHwsMdKJIb6IjY4_8aSzP3ecgnBYjhdIf1g1QcLg" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/teams`

```
POST /1.1/2065/teams
Accept: application/json
Content-Type: application/json
Authorization: Bearer tZsTHwsMdKJIb6IjY4_8aSzP3ecgnBYjhdIf1g1QcLg
```

#### Parameters

```
{"name":null,"team":{"name":"Timely","color":"67a3bc","emoji":"http://path.to/emoji.png","external_id":null,"users":[{"user_id":5222,"lead":true},{"user_id":5224,"lead":false}]}}
```

| Name | Description |
| --- | --- |
| name _required_ | Specifies the team name |
| emoji | Specifies the emoji url for a team |
| color | Specifies the project color for a team |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| users _required_ | Specifies users and their role within a team. For example: users:[{'user_id': 1, 'lead': true}] |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 41,
  "name": "Timely",
  "color": "67a3bc",
  "emoji": "http://path.to/emoji.png",
  "external_id": null,
  "project_ids": [],
  "user_ids": [
    5222,
    5224
  ],
  "users": [
    {
      "id": 51,
      "user_id": 5222,
      "team_id": 41,
      "lead": true,
      "hide_hours": false
    },
    {
      "id": 52,
      "user_id": 5224,
      "team_id": 41,
      "lead": false,
      "hide_hours": false
    }
  ]
}
```

Delete a team
-------------

### Request

```
curl "https://api.timelyapp.com/1.1/2066/teams/42" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 2V71-YCzgaHO_zQr0qIlcCw7IwRHMn0t4kQVW8w1DwE" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/teams/:id`

```
DELETE /1.1/2066/teams/42
Accept: application/json
Content-Type: application/json
Authorization: Bearer 2V71-YCzgaHO_zQr0qIlcCw7IwRHMn0t4kQVW8w1DwE
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the team you want to delete |
| id | The ID of the team you want to delete |
| delete_project_users | Specifies if associated users should be removed from team projects. For example: "delete_project_users":true. Default: false |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

List all teams
--------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/2068/teams" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer c6D5ks2bd5mR5C85BGyzkxjEleZDvT_xXEklerkFrFg" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/teams`

```
GET /1.1/2068/teams
Accept: application/json
Content-Type: application/json
Authorization: Bearer c6D5ks2bd5mR5C85BGyzkxjEleZDvT_xXEklerkFrFg
```

#### Parameters

| Name | Description |
| --- | --- |
| page | Page number (Default 1) |
| per_page | Records per page (Default 50) |
| order | Sorting order on name |
| filter | Filter teams - mine, all |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 44,
    "name": "Timely",
    "color": "67a3bc",
    "emoji": "http://path.to/emoji.png",
    "external_id": null,
    "project_ids": [],
    "user_ids": [],
    "users": []
  }
]
```

Retrieve a team
---------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/2067/teams/43" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer meiIxhs6LVkucvKHKayXXJ8D9eEPNeyXS2-qfQd4sRA" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/teams/:id`

```
GET /1.1/2067/teams/43
Accept: application/json
Content-Type: application/json
Authorization: Bearer meiIxhs6LVkucvKHKayXXJ8D9eEPNeyXS2-qfQd4sRA
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the team you want to retrieve |
| id | The ID of the team you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 43,
  "name": "Timely",
  "color": "67a3bc",
  "emoji": "http://path.to/emoji.png",
  "external_id": null,
  "project_ids": [],
  "user_ids": [],
  "users": []
}
```

Update a team
-------------

### Request

```
curl "https://api.timelyapp.com/1.1/2069/teams/45" -d '{"name":null,"team":{"name":"Backend","color":"67a3bc","emoji":"http://path.to/emoji.png","external_id":null,"users":[{"user_id":5231,"lead":true}]}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer vVG2OV2JWBNK7_bNaMiBxhJXZFnzn31_jEpNPKutRdQ" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/teams/:id`

```
PUT /1.1/2069/teams/45
Accept: application/json
Content-Type: application/json
Authorization: Bearer vVG2OV2JWBNK7_bNaMiBxhJXZFnzn31_jEpNPKutRdQ
```

#### Parameters

```
{"name":null,"team":{"name":"Backend","color":"67a3bc","emoji":"http://path.to/emoji.png","external_id":null,"users":[{"user_id":5231,"lead":true}]}}
```

| Name | Description |
| --- | --- |
| name _required_ | Specifies the team name |
| emoji | Specifies the emoji url for a team |
| color | Specifies the project color for a team |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| users _required_ | Specific users with their role in the team. Ex: users:[{'user_id': 1, 'lead': true}] |
| add_users_to_team_projects | Specifies if the user should be added to team projects. For example: "add_users_to_team_projects":false. Default: true |
| delete_users_from_team_projects | Specifies if the removed user should be removed from team projects. For example: "delete_users_from_team_projects":true. Default: false |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 45,
  "name": "Backend",
  "color": "67a3bc",
  "emoji": "http://path.to/emoji.png",
  "external_id": null,
  "project_ids": [],
  "user_ids": [
    5231
  ],
  "users": [
    {
      "id": 53,
      "user_id": 5231,
      "team_id": 45,
      "lead": true,
      "hide_hours": false
    }
  ]
}
```

UserCapacities
--------------

Retrieve capacities
-------------------

See capacities of multiple users in the account

### Request

```
curl -g "https://api.timelyapp.com/1.1/2074/users/capacities" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 7Nl27N7d_VDt1Azgo9TWUSCK7Oc5SVVVeIiLV3mXe1I" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/capacities`

```
GET /1.1/2074/users/capacities
Accept: application/json
Content-Type: application/json
Authorization: Bearer 7Nl27N7d_VDt1Azgo9TWUSCK7Oc5SVVVeIiLV3mXe1I
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id _required_ | Account for which users' capacities are required |
| user_ids | Users whose capacities are required |
| since | Fetch capacities after selected date |
| until | Fetch capacities before selected date |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "user_id": 5241,
    "capacities": [
      {
        "id": null,
        "weekly_capacity": 40.0,
        "daily_capacity": 8.0,
        "weekdays": "MO,TU,WE,TH,FR",
        "work_days": "MON,TUE,WED,THU,FRI",
        "total_working_days": null,
        "weekly_working_days": 5,
        "current": true,
        "start_date": "1970-01-01",
        "end_date": null
      }
    ]
  }
]
```

Retrieve user's capacities
--------------------------

Using the user id one can see the user's capacities

### Request

```
curl -g "https://api.timelyapp.com/1.1/2073/users/5239/capacities" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer u9hS83qlTtpoM5uLUGBxj_hGWcnI3aoRSL1tC78KxnI" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/:user_id/capacities`

```
GET /1.1/2073/users/5239/capacities
Accept: application/json
Content-Type: application/json
Authorization: Bearer u9hS83qlTtpoM5uLUGBxj_hGWcnI3aoRSL1tC78KxnI
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id _required_ | Account for which user's capacities are required |
| user_id _required_ | User whose capacities are required |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": null,
    "weekly_capacity": 40.0,
    "daily_capacity": 8.0,
    "weekdays": "MO,TU,WE,TH,FR",
    "work_days": "MON,TUE,WED,THU,FRI",
    "total_working_days": null,
    "weekly_working_days": 5,
    "current": true,
    "start_date": "1970-01-01",
    "end_date": null
  }
]
```

Users
-----

An account can have multiple users associated with it. All users have a specific access level, and are usually created by an employer on behalf of an employee.

Create/Invite a user
--------------------

Note: user_level can have values “normal” or “limited”. A user’s name and email can only be updated by the user themself.

### Request

```
curl "https://api.timelyapp.com/1.1/2076/users" -d '{"user":{"name":"Marija Petrovic","email":"marija@timely.com","user_level":"normal","admin":false,"projects":[{"project_id":2139,"hour_rate":10}]},"name":null,"admin":{"id":1666,"email":"notifications@timelyapp.com","created_at":"2025-07-03T04:47:52.000Z","updated_at":"2025-07-03T04:47:52.000Z","name":"Timely","notifier":true}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer DHbpq3qAZohrC3Wg_lHJlw_vnXzttB9ri-jsLpTFiio" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/users`

```
POST /1.1/2076/users
Accept: application/json
Content-Type: application/json
Authorization: Bearer DHbpq3qAZohrC3Wg_lHJlw_vnXzttB9ri-jsLpTFiio
```

#### Parameters

```
{"user":{"name":"Marija Petrovic","email":"marija@timely.com","user_level":"normal","admin":false,"projects":[{"project_id":2139,"hour_rate":10}]},"name":null,"admin":{"id":1666,"email":"notifications@timelyapp.com","created_at":"2025-07-03T04:47:52.000Z","updated_at":"2025-07-03T04:47:52.000Z","name":"Timely","notifier":true}}
```

| Name | Description |
| --- | --- |
| user _required_ | User attributes |
| name _required_ | Specifies the user name |
| email _required_ | Specifies the user email |
| projects | Description: Specifies the projects that the user will be part of. For example: "projects": [ {"project_id": 11 , "hour_rate": 10 }, {"project_id": 12 , "hour_rate": 20 }] |
| role_id _required_ | Specifies the user's role in the account |
| user_level | (Deprecated) Specifies the user level; either “normal” or “limited”. The default is "normal". For example: "user_level": "normal" |
| admin | (Deprecated) Specifies the user is an admin. In this case user_level should be “normal”. For example: "admin": "true" |
| external_id | The external_id can be used to reference external resource IDs to Timely resources, and should be alphanumeric (max. 512 characters) |
| weekly_capacity | Specifies the user's weekly hour capacity. The default is account's weekly capacity. To avoid rounding issues, values are allowed upto 1 decimal place and divisible by 5. |
| add_to_all_projects | Specifies whether the user should be added to all projects in the account. For example: "add_to_all_projects":true |
| internal_hour_rate | Specifies the internal hourly rate for users in the account |
| hide_internal_hourly_rate | The hide_internal_hourly_rate hides the internal hourly rate for users in the account. The default is true. For example: "hide_internal_hourly_rate": true |
| team_ids | Specifies the teams that the user will be part of, should be array of numerical team id's. Example values: team_ids: [3,4,2] |
| add_team_users_to_projects | Specifies if the user should be added to team projects Specified in team_ids. For example: "add_team_users_to_projects":false. Default: true |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 5247,
  "email": "marija@timely.com",
  "name": "Marija Petrovic",
  "active": false,
  "day_view_onboarded": false,
  "memory_onboarded": false,
  "created_at": 1751518072,
  "updated_at": 1751518072,
  "last_received_memories_date": null,
  "sign_in_count": null,
  "external_id": null,
  "time_zone": "Etc/UTC",
  "memory_retention_days": null,
  "avatar": {
    "large_retina": "https://www.gravatar.com/avatar/0a8763ca707efea0026580f1712c3fe0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "large": "https://www.gravatar.com/avatar/0a8763ca707efea0026580f1712c3fe0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "medium_retina": "https://www.gravatar.com/avatar/0a8763ca707efea0026580f1712c3fe0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "medium": "https://www.gravatar.com/avatar/0a8763ca707efea0026580f1712c3fe0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "small_retina": "https://www.gravatar.com/avatar/0a8763ca707efea0026580f1712c3fe0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25",
    "small": "https://www.gravatar.com/avatar/0a8763ca707efea0026580f1712c3fe0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25"
  },
  "type": "User",
  "work_days": "MON,TUE,WED,THU,FRI",
  "weekdays": "MO,TU,WE,TH,FR",
  "weekly_capacity": 40.0,
  "user_level": "manager",
  "admin": false,
  "hide_hourly_rate": false,
  "hide_internal_hourly_rate": false,
  "deleted": false,
  "default_hour_rate": 0.0,
  "internal_hour_rate": 0.0,
  "role_id": 8302,
  "role": {
    "id": 8302,
    "name": "manager"
  }
}
```

Delete a user
-------------

### Request

```
curl "https://api.timelyapp.com/1.1/2077/users/5248" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer xg8CSyx8vtbgCWWsKZJGChnBetv_XCLLfY-kWJZHF2M" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/users/:id`

```
DELETE /1.1/2077/users/5248
Accept: application/json
Content-Type: application/json
Authorization: Bearer xg8CSyx8vtbgCWWsKZJGChnBetv_XCLLfY-kWJZHF2M
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the user you want to delete |
| id | The ID of the user you want to delete |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

List all users
--------------

Note: The user list will return the 100 most recently updated users.

### Request

```
curl -g "https://api.timelyapp.com/1.1/2080/users" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer CWXpyoBb7tE18-D2Y7qitseOLncNAjHpr53Mire4560" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users`

```
GET /1.1/2080/users
Accept: application/json
Content-Type: application/json
Authorization: Bearer CWXpyoBb7tE18-D2Y7qitseOLncNAjHpr53Mire4560
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the users you want to retrieve |
| limit | Retrieve a limited number of users (Default 100) |
| offset | Retrieve users from offset |
| order | Sorting order on updated_at - desc, asc (Default desc) |
| filter | Filter users - active, deleted (Default active) |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[
  {
    "id": 5254,
    "email": "marijawfykguzm@timelyapp.com",
    "name": "Marija Petrovic",
    "active": false,
    "day_view_onboarded": true,
    "memory_onboarded": true,
    "created_at": 1751518074,
    "updated_at": 1751518074,
    "last_received_memories_date": null,
    "sign_in_count": null,
    "external_id": null,
    "time_zone": "Europe/Paris",
    "memory_retention_days": null,
    "avatar": {
      "large_retina": "https://www.gravatar.com/avatar/d2d332eb831c5dd9bb4b6d16df7474c8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "large": "https://www.gravatar.com/avatar/d2d332eb831c5dd9bb4b6d16df7474c8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
      "medium_retina": "https://www.gravatar.com/avatar/d2d332eb831c5dd9bb4b6d16df7474c8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "medium": "https://www.gravatar.com/avatar/d2d332eb831c5dd9bb4b6d16df7474c8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
      "small_retina": "https://www.gravatar.com/avatar/d2d332eb831c5dd9bb4b6d16df7474c8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25",
      "small": "https://www.gravatar.com/avatar/d2d332eb831c5dd9bb4b6d16df7474c8?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25"
    },
    "type": "User",
    "work_days": "MON,TUE,WED,THU,FRI",
    "weekdays": "MO,TU,WE,TH,FR",
    "weekly_capacity": 40.0,
    "user_level": "admin",
    "admin": true,
    "hide_hourly_rate": false,
    "hide_internal_hourly_rate": true,
    "deleted": false,
    "default_hour_rate": 0.0,
    "internal_hour_rate": 0.0,
    "role_id": 8317,
    "role": {
      "id": 8317,
      "name": "admin"
    }
  }
]
```

Retrieve a user
---------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/2078/users/5250" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 0jmE4LpHlVniBgEubrBBrqvsI3JI4SEjTaxFaIkZemY" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/:id`

```
GET /1.1/2078/users/5250
Accept: application/json
Content-Type: application/json
Authorization: Bearer 0jmE4LpHlVniBgEubrBBrqvsI3JI4SEjTaxFaIkZemY
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the users you want to retrieve |
| id | The ID of the user you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 5250,
  "email": "marijadmsbuexd@timelyapp.com",
  "name": "Marija Petrovic",
  "active": false,
  "day_view_onboarded": true,
  "memory_onboarded": true,
  "created_at": 1751518073,
  "updated_at": 1751518073,
  "last_received_memories_date": null,
  "sign_in_count": null,
  "external_id": null,
  "time_zone": "Europe/Paris",
  "memory_retention_days": null,
  "avatar": {
    "large_retina": "https://www.gravatar.com/avatar/78ac3bff8ab0986ea1b682a9a831cbfd?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "large": "https://www.gravatar.com/avatar/78ac3bff8ab0986ea1b682a9a831cbfd?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "medium_retina": "https://www.gravatar.com/avatar/78ac3bff8ab0986ea1b682a9a831cbfd?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "medium": "https://www.gravatar.com/avatar/78ac3bff8ab0986ea1b682a9a831cbfd?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "small_retina": "https://www.gravatar.com/avatar/78ac3bff8ab0986ea1b682a9a831cbfd?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25",
    "small": "https://www.gravatar.com/avatar/78ac3bff8ab0986ea1b682a9a831cbfd?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25"
  },
  "type": "User",
  "work_days": "MON,TUE,WED,THU,FRI",
  "weekdays": "MO,TU,WE,TH,FR",
  "weekly_capacity": 40.0,
  "active_projects_count": 1,
  "user_level": "admin",
  "admin": true,
  "hide_hourly_rate": false,
  "hide_internal_hourly_rate": true,
  "deleted": false,
  "default_hour_rate": 0.0,
  "internal_hour_rate": 0.0,
  "role_id": 8309,
  "role": {
    "id": 8309,
    "name": "admin"
  }
}
```

Retrieve current user
---------------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/2079/users/current" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 240SG9TqYMDggHGfMY0nXTQehtAwU5PnEVVWyAPNo-E" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/users/current`

```
GET /1.1/2079/users/current
Accept: application/json
Content-Type: application/json
Authorization: Bearer 240SG9TqYMDggHGfMY0nXTQehtAwU5PnEVVWyAPNo-E
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the current user |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 5252,
  "email": "marijafdbihphr@timelyapp.com",
  "name": "Marija Petrovic",
  "active": false,
  "day_view_onboarded": true,
  "memory_onboarded": true,
  "created_at": 1751518073,
  "updated_at": 1751518073,
  "last_received_memories_date": null,
  "sign_in_count": null,
  "external_id": null,
  "time_zone": "Europe/Paris",
  "memory_retention_days": null,
  "avatar": {
    "large_retina": "https://www.gravatar.com/avatar/b0aaa8b3f1ce2ff554765c79aac439a0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "large": "https://www.gravatar.com/avatar/b0aaa8b3f1ce2ff554765c79aac439a0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "medium_retina": "https://www.gravatar.com/avatar/b0aaa8b3f1ce2ff554765c79aac439a0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "medium": "https://www.gravatar.com/avatar/b0aaa8b3f1ce2ff554765c79aac439a0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "small_retina": "https://www.gravatar.com/avatar/b0aaa8b3f1ce2ff554765c79aac439a0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25",
    "small": "https://www.gravatar.com/avatar/b0aaa8b3f1ce2ff554765c79aac439a0?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25"
  },
  "type": "User",
  "work_days": "MON,TUE,WED,THU,FRI",
  "weekdays": "MO,TU,WE,TH,FR",
  "weekly_capacity": 40.0,
  "user_level": "admin",
  "admin": true,
  "hide_hourly_rate": false,
  "hide_internal_hourly_rate": true,
  "deleted": false,
  "default_hour_rate": 0.0,
  "internal_hour_rate": 0.0,
  "role_id": 8313,
  "role": {
    "id": 8313,
    "name": "admin"
  }
}
```

Update a user
-------------

Note:

Please use the parameters mentioned in “Create/Invite a user”.

Only admins can edit “user_level” and “projects” fields for other users.

### Request

```
curl "https://api.timelyapp.com/1.1/2081/users/5256" -d '{"user":{"admin":{"id":1671,"email":"notifications@timelyapp.com","created_at":"2025-07-03T04:47:54.000Z","updated_at":"2025-07-03T04:47:54.000Z","name":"Timely","notifier":true},"role_id":8321,"projects":[{"project_id":2144,"hour_rate":10}]}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 1IULVCMwxS7SmNSgtnuthsb4HixCNZeYfmX0BDUsksU" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/users/:id`

```
PUT /1.1/2081/users/5256
Accept: application/json
Content-Type: application/json
Authorization: Bearer 1IULVCMwxS7SmNSgtnuthsb4HixCNZeYfmX0BDUsksU
```

#### Parameters

```
{"user":{"admin":{"id":1671,"email":"notifications@timelyapp.com","created_at":"2025-07-03T04:47:54.000Z","updated_at":"2025-07-03T04:47:54.000Z","name":"Timely","notifier":true},"role_id":8321,"projects":[{"project_id":2144,"hour_rate":10}]}}
```

| Name | Description |
| --- | --- |
| id _required_ | The numerical ID of the user |
| user _required_ | Label attributes |
| user[projects] | Specifies the projects that the user will be part of. For example: "projects": [ {"project_id": 11 , "hour_rate": 10 }, {"project_id": 12 , "hour_rate": 20 }] |
| user[role_id] _required_ | Specifies the user's role in the account |
| user[user_level] | (Deprecated) Specifies the user level; either “normal” or “limited”. The default is "normal". For example: "user_level": "normal" |
| user[admin] | (Deprecated) Specifies the user is an admin. In this case user_level should be “normal”. For example: "admin": "true" |
| user[weekly_capacity] | Specifies the user's weekly hour capacity. The default is the account's weekly capacity. To avoid rounding issues, values are allowed upto 1 decimal place and divisible by 5. |
| user[add_to_all_projects] | Specifies whether the user should be added to all projects in the account. For example: "add_to_all_projects":true |
| user[internal_hour_rate] | Specifies the internal hourly rate for users in the account |
| user[hide_internal_hourly_rate] | The hide_internal_hourly_rate hides the internal hourly rate for users in the account. The default is true. For example: "hide_internal_hourly_rate": true |
| update_existing_hours | Specifies if the updated hour rate should be applied to existing hours. For example: "update_existing_hours":false. Default: true |
| update_unbilled_only | Specifies if the updated hour rate should only be applied to unbilled hours. This is ignored if "update_existing_hours" is false. For example: "update_unbilled_only":true. Default: false |
| update_existing_hours_internal_rate | Specifies if the updated internal hour rate should be applied to existing hours. For example: "update_existing_hours_internal_rate":false. Default: true |
| update_unbilled_hours_internal_rate | Specifies if the updated internal hour rate should only be applied to unbilled hours. This is ignored if "update_existing_hours_internal_rate" is false. For example: "update_unbilled_hours_internal_rate":true. Default: false |
| team_ids | Specifies the teams that the user will be part of, should be array of numerical team id's. Example values: team_ids: [3,4,2] |
| add_team_users_to_projects | Specifies if the user should be added to team projects Specified in team_ids. For example: "add_team_users_to_projects":false. Default: true |
| remove_team_users_from_projects | Specifies if the user should be removed from team projects not specified in team_ids. For example: "remove_team_users_from_projects":true. Default: false |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 5256,
  "email": "marijadqkutzcz@timelyapp.com",
  "name": "Marija Petrovic",
  "active": false,
  "day_view_onboarded": true,
  "memory_onboarded": true,
  "created_at": 1751518074,
  "updated_at": 1751518074,
  "last_received_memories_date": null,
  "sign_in_count": null,
  "external_id": null,
  "time_zone": "Europe/Paris",
  "memory_retention_days": null,
  "avatar": {
    "large_retina": "https://www.gravatar.com/avatar/38023cb368598f3ec4f483165ae4cf48?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "large": "https://www.gravatar.com/avatar/38023cb368598f3ec4f483165ae4cf48?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_large_retina-c403e04ad44c7d8b8c7904dc7e7c1893101f3672565370034edbe3dee9985509.jpg&s=200",
    "medium_retina": "https://www.gravatar.com/avatar/38023cb368598f3ec4f483165ae4cf48?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "medium": "https://www.gravatar.com/avatar/38023cb368598f3ec4f483165ae4cf48?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_medium_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=50",
    "small_retina": "https://www.gravatar.com/avatar/38023cb368598f3ec4f483165ae4cf48?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25",
    "small": "https://www.gravatar.com/avatar/38023cb368598f3ec4f483165ae4cf48?d=http%3A%2F%2Fapp.timelyapp.local%3A3002%2Fassets%2Fthumbs%2Fuser_small_retina-459a8b7582a7417f4b47a0064f692ffcd161fb11eda9dcc359f1b5e63fe51235.jpg&s=25"
  },
  "type": "User",
  "work_days": "MON,TUE,WED,THU,FRI",
  "weekdays": "MO,TU,WE,TH,FR",
  "weekly_capacity": 40.0,
  "user_level": "admin",
  "admin": true,
  "hide_hourly_rate": false,
  "hide_internal_hourly_rate": false,
  "deleted": false,
  "default_hour_rate": 0.0,
  "internal_hour_rate": 0.0,
  "role_id": 8321,
  "role": {
    "id": 8321,
    "name": "admin"
  }
}
```

Webhooks
--------

Webhooks allow external services to be notified when certain events happen. When the specified events happen, we’ll send a POST request to each of the URLs you provide.

Create a webhook
----------------

### Request

```
curl "https://api.timelyapp.com/1.1/2086/webhooks" -d '{"webhook":{"url":"https://nader.name/elinore","subscriptions":["projects:created"],"active":true,"secret_token":"deadbeef"}}' -X POST \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 7b7ex_-lLqOC2t9uTzHdTDLV__JQUOrWATQQpj8AQ1Q" \
    -H "Cookie: "
```

#### Endpoint

`POST /1.1/:account_id/webhooks`

```
POST /1.1/2086/webhooks
Accept: application/json
Content-Type: application/json
Authorization: Bearer 7b7ex_-lLqOC2t9uTzHdTDLV__JQUOrWATQQpj8AQ1Q
```

#### Parameters

```
{"webhook":{"url":"https://nader.name/elinore","subscriptions":["projects:created"],"active":true,"secret_token":"deadbeef"}}
```

| Name | Description |
| --- | --- |
| url _required_ | The URL of the endpoint that will receive the webhook POST requests. (HTTPS required) |
| secret_token | Setting a webhook secret allows you to ensure that requests sent to the above webhook endpoint are from us. You'll receive a signature in the X-Signature header value. Calculate a SHA256 hash for the received payload using your provided SECRET_TOKEN on your end, and ensure that the result matches the X-Signature value. |
| subscriptions | Specifies the array of events should it listen to. The format is ['entity:action', ...]. Eg. ['project:created']. Use the wildcard (*) character for all events or all actions of an entity. Support subscriptions: * forecasts:created * forecasts:updated * forecasts:deleted * hours:created * hours:updated * hours:deleted * labels:created * labels:updated * labels:deleted * projects:created * projects:updated * projects:deleted |
| active | By default, webhook deliveries are active. You can choose to disable the delivery of webhook payloads by disable this. |

### Response

```
Content-Type: application/json; charset=utf-8
201 Created
```

```
{
  "id": 21,
  "account_id": 2086,
  "url": "https://nader.name/elinore",
  "subscriptions": [
    "projects:created"
  ],
  "secret_token": "deadbeef",
  "active": true,
  "created_at": "2025-07-03T06:47:56+02:00",
  "updated_at": "2025-07-03T06:47:56+02:00"
}
```

Delete a webhook
----------------

### Request

```
curl "https://api.timelyapp.com/1.1/2087/webhooks/22" -d '' -X DELETE \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer nSHalUFeDrW1SWcOf8wRUpCujJEapHbxsh0NHe8_s4g" \
    -H "Cookie: "
```

#### Endpoint

`DELETE /1.1/:account_id/webhooks/:id`

```
DELETE /1.1/2087/webhooks/22
Accept: application/json
Content-Type: application/json
Authorization: Bearer nSHalUFeDrW1SWcOf8wRUpCujJEapHbxsh0NHe8_s4g
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the webhook you want to delete |
| id | The ID of the webhook you want to delete |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{}
```

List all webhooks
-----------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/2089/webhooks" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer BOgrMaedF120oVDF54x5rmOh7FiixwIzvC2x4j1cUfI" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/webhooks`

```
GET /1.1/2089/webhooks
Accept: application/json
Content-Type: application/json
Authorization: Bearer BOgrMaedF120oVDF54x5rmOh7FiixwIzvC2x4j1cUfI
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the webhooks you want to retrieve |
| offset | Retrieve webhooks from offset |
| limit | Retrieve number of webhooks |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
[]
```

Retrieve a webhook
------------------

### Request

```
curl -g "https://api.timelyapp.com/1.1/2088/webhooks/23" -X GET \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer jSB2worTFZ7oE0LQkJJat2Tg9wfUUKiherRSYDGw_dk" \
    -H "Cookie: "
```

#### Endpoint

`GET /1.1/:account_id/webhooks/:id`

```
GET /1.1/2088/webhooks/23
Accept: application/json
Content-Type: application/json
Authorization: Bearer jSB2worTFZ7oE0LQkJJat2Tg9wfUUKiherRSYDGw_dk
```

#### Parameters

| Name | Description |
| --- | --- |
| account_id | The account ID containing the webhook you want to retrieve |
| id | The ID of the webhook you want to retrieve |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 23,
  "account_id": 2088,
  "url": "https://sawayn.io/archie",
  "subscriptions": [
    "projects:created"
  ],
  "secret_token": null,
  "active": true,
  "created_at": "2025-07-03T06:47:57+02:00",
  "updated_at": "2025-07-03T06:47:57+02:00"
}
```

Update a webhook
----------------

### Request

```
curl "https://api.timelyapp.com/1.1/2090/webhooks/24" -d '{"webhook":{"subscriptions":["projects:created","labels:created"],"secret_token":"deadbeef"}}' -X PUT \
    -H "Version: HTTP/1.0" \
    -H "Host: api.timelyapp.com" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer RN5ca2uNebhrELHH0KgB-1TZGKc5kkMuvXCd0d6NsI0" \
    -H "Cookie: "
```

#### Endpoint

`PUT /1.1/:account_id/webhooks/:id`

```
PUT /1.1/2090/webhooks/24
Accept: application/json
Content-Type: application/json
Authorization: Bearer RN5ca2uNebhrELHH0KgB-1TZGKc5kkMuvXCd0d6NsI0
```

#### Parameters

```
{"webhook":{"subscriptions":["projects:created","labels:created"],"secret_token":"deadbeef"}}
```

| Name | Description |
| --- | --- |
| id _required_ | Webhook ID |
| url _required_ | The URL of the endpoint that will receive the webhook POST requests. (HTTPS required) |
| secret_token | Setting a webhook secret allows you to ensure that requests sent to the above webhook endpoint are from us. You'll receive a signature in the X-Signature header value. Calculate a SHA256 hash for the received payload using your provided SECRET_TOKEN on your end, and ensure that the result matches the X-Signature value. |
| subscriptions | Specifies the array of events should it listen to. The format is ['entity:action', ...]. Eg. ['projects:created']. Use the wildcard (*) character for all events or all actions of an entity. |
| active | Example values: "true" or "false" |

### Response

```
Content-Type: application/json; charset=utf-8
200 OK
```

```
{
  "id": 24,
  "account_id": 2090,
  "url": "https://kreiger.name/ozzie",
  "subscriptions": [
    "projects:created",
    "labels:created"
  ],
  "secret_token": "deadbeef",
  "active": true,
  "created_at": "2025-07-03T06:47:57+02:00",
  "updated_at": "2025-07-03T06:47:57+02:00"
}
```

Errors
------

> Example responses:

```
422 Unprocessable Entity
```

```
{
  "errors":{
    "name":[
      "can't be blank"
    ],
    "project_users":[
      "is invalid"
    ]
  }
}
```

```
422 Unprocessable Entity
```

```
403 Forbidden
```

```
{
  "errors":{
    "message":"error message"
  }
}
```

```
404 Not Found
```

```
{
  "errors":{
    "message":"Not Found"
  }
}
```

```
401 Unauthorized
```

```
{
  "errors":{
    "message":"Unauthorized"
  }
}
```

Timely uses conventional HTTP response codes to indicate the success or failure of an API request. Codes in the 2xx range indicate success. Codes in the 4xx range indicate an error that failed due to the information provided. Codes in the 5xx range indicate an error with Timely's servers.

Unauthorized access o projects and accounts, or trying to create or delete objects that are not under our control, will result in errors.

The Timely API uses the following error codes:

| Error Code | Meaning |
| --- | --- |
| 400 - Bad Request | Your request is invalid |
| 401 - Unauthorized | Wrong authentication token was used |
| 403 - Forbidden | The entity requested is hidden from unauthorized access |
| 404 - Not Found | The specified entity could not be found |
| 422 - Unprocessable Entity | The server understands the content type, but was unable to process the request |
| 500 - Internal Server Error | We’re experiencing a problem with our server. Try again later. |