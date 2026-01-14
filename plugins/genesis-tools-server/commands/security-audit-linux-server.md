---
description: Comprehensive security audit - analyze logs, detect attacks, scan for malware/rootkits, generate fail2ban commands
allowed-tools: *
--

###allowed-tools: Bash, Read, Grep, Glob, Task, WebFetch, WebSearch

# Linux Server Security Audit

You are performing a comprehensive security audit on this Linux server. Analyze all security logs, detect attack patterns, identify malicious IPs, check security tool status, and run malware/rootkit scans.

---

## PHASE 1: System Information

### Server Identity
`hostname && date && uptime`

### OS Information
`cat /etc/os-release 2>/dev/null | head -5`

---

## PHASE 2: Security Log Collection

### 2.1 SSH Authentication Failures (auth.log)
`tail -2000 /var/log/auth.log 2>/dev/null | grep -E "(Invalid user|Failed password|authentication failure|Accepted password|Accepted publickey)" | tail -500`

### 2.2 Fail2ban Activity
`fail2ban-client status 2>/dev/null || echo "fail2ban not running"`

`fail2ban-client status sshd 2>/dev/null | grep -E "(Currently banned|Total banned|Banned IP)" || echo "sshd jail not active"`

`tail -1000 /var/log/fail2ban.log 2>/dev/null | grep -E "(Ban|Unban|Found)" | tail -200`

### 2.3 Apache/Web Server Attacks (4000+ lines analyzed)
`cat /var/log/apache2/*.log 2>/dev/null | tail -4000 | grep -iE "(wp-admin|wp-content|wp-includes|\.php.*(shell|cmd|eval|exec|passthru|system|base64)|password\.php|admin\.php|\.env|phpmyadmin|adminer|cgi-bin|UNION.*SELECT|SELECT.*FROM|DROP.*TABLE|1=1|OR.*=|\.\.\/|\.\.%2f|/etc/passwd|\.git|\.svn|\.htaccess|\.htpasswd|xmlrpc\.php|wp-login)" | tail -500`

### 2.4 High 404 Error Sources (Scanner Detection)
`cat /var/log/apache2/*.log 2>/dev/null | tail -4000 | grep " 404 " | awk '{print $1}' | sort | uniq -c | sort -rn | head -30`

### 2.5 Suspicious User Agents
`cat /var/log/apache2/*.log 2>/dev/null | tail -4000 | grep -iE "(nikto|sqlmap|nmap|masscan|zgrab|curl|wget|python-requests|go-http-client|libwww)" | awk '{print $1}' | sort | uniq -c | sort -rn | head -20`

### 2.6 Auditd Events (if available)
`tail -500 /var/log/audit/audit.log 2>/dev/null | grep -E "(EXECVE|SYSCALL|USER_AUTH|USER_LOGIN|ANOM)" | tail -100 || echo "auditd not available"`

### 2.7 Firewall Activity (iptables/nftables)
`dmesg 2>/dev/null | grep -iE "(DROP|REJECT|BLOCK|iptables|nftables)" | tail -50 || echo "No firewall logs in dmesg"`

`grep -iE "(DROP|REJECT|BLOCK)" /var/log/kern.log 2>/dev/null | tail -50 || echo "No firewall logs in kern.log"`

### 2.8 Current Firewall Rules
`iptables -L -n -v 2>/dev/null | head -50 || echo "iptables not available"`

`nft list ruleset 2>/dev/null | head -50 || echo "nftables not available"`

---

## PHASE 3: Security Scanner Status

### 3.1 ClamAV Status
`clamscan --version 2>/dev/null || echo "ClamAV not installed"`
`systemctl status clamav-freshclam 2>/dev/null | grep -E "(Active|ago)" | head -3 || echo "freshclam service not found"`
`ls -la /var/log/clamav/ 2>/dev/null | tail -5 || echo "No ClamAV logs found"`

### 3.2 chkrootkit Status
`chkrootkit -V 2>/dev/null || echo "chkrootkit not installed"`
`ls -la /var/log/chkrootkit* 2>/dev/null || echo "No chkrootkit logs found"`

### 3.3 rkhunter Status
`rkhunter --versioncheck 2>/dev/null | head -5 || echo "rkhunter not installed"`
`ls -la /var/log/rkhunter.log 2>/dev/null || echo "No rkhunter log found"`
`tail -20 /var/log/rkhunter.log 2>/dev/null | grep -E "(Warning|Infected)" || echo "No recent rkhunter warnings"`

---

## PHASE 4: Analysis Instructions

Based on the log data collected above, perform the following analysis:

### 4.1 Attack Categorization
Categorize all detected attacks into these types:
- **SSH Brute Force**: Invalid users, failed passwords from auth.log
- **WordPress Attacks**: wp-admin, wp-content, wp-includes, xmlrpc.php probing
- **Web Shell Probing**: .php files with suspicious names (shell, password, admin, cmd, eval)
- **SQL Injection Attempts**: UNION, SELECT, DROP, --, 'OR, 1=1 patterns
- **Path Traversal**: ../, ..%2f, /etc/passwd attempts
- **CGI Attacks**: /cgi-bin/ probing
- **Database Admin Probing**: PHPMyAdmin, Adminer access attempts
- **Environment File Exposure**: .env, .env.local, .htpasswd attempts
- **Scanner Activity**: IPs with multiple 404s (>10), known scanner user agents
- **Git/SVN Exposure**: .git, .svn directory probing

### 4.2 Malicious IP Extraction
Extract unique IP addresses that performed attacks. Deduplicate and rank by:
1. Number of attack attempts
2. Variety of attack types attempted
3. Recency of attacks
4. Whether already banned by fail2ban

### 4.3 Threat Research
For any unknown or sophisticated attack patterns, use WebFetch or WebSearch (or Brave MCP if available) to research:
- Known malware signatures
- Botnet IP ranges
- Attack campaign information

---

## PHASE 5: Launch Security Scanners (Parallel Background Agents)

**IMPORTANT**: Launch these 3 agents IN PARALLEL using the Task tool with `run_in_background: true`. Do this in a SINGLE message with 3 Task tool calls.

### Agent 1: ClamAV Malware Scan
```
Launch a background Task agent with this prompt:

"You are running a ClamAV malware scan on this Linux server.

1. First, update virus definitions:
   Run: sudo freshclam

2. Then run a scan on critical directories:
   Run: sudo clamscan -r --infected --log=/tmp/clamav-audit-$(date +%Y%m%d).log /home /var/www /tmp /var/tmp 2>&1

3. Read the scan results and analyze:
   - List any FOUND/INFECTED files
   - For each threat found, use WebFetch or WebSearch to research what the malware does
   - Provide remediation steps for each infected file

4. Report your findings in this format:
   ## ClamAV Scan Results
   **Scan Date:** [date]
   **Directories Scanned:** /home, /var/www, /tmp, /var/tmp
   **Infected Files Found:** [count]

   ### Threats Detected
   | File Path | Threat Name | Severity | Remediation |
   |-----------|-------------|----------|-------------|

   ### Recommended Actions
   - [list of actions]
"
```

### Agent 2: chkrootkit Rootkit Scan
```
Launch a background Task agent with this prompt:

"You are running a chkrootkit rootkit scan on this Linux server.

1. Ensure chkrootkit is up to date:
   Run: which chkrootkit || echo 'chkrootkit not installed - recommend: apt install chkrootkit'

2. Run the rootkit scan:
   Run: sudo chkrootkit 2>&1 | tee /tmp/chkrootkit-audit-$(date +%Y%m%d).log

3. Analyze the results:
   - Look for any INFECTED entries
   - Note any suspicious entries or warnings
   - For any detected rootkits, use WebFetch or WebSearch to research them

4. Report your findings in this format:
   ## chkrootkit Scan Results
   **Scan Date:** [date]
   **Status:** [CLEAN / WARNINGS / INFECTED]

   ### Findings
   | Check | Status | Details |
   |-------|--------|---------|

   ### Research on Detected Threats
   [If any threats found, include research from web]

   ### Recommended Actions
   - [list of actions]
"
```

### Agent 3: rkhunter Rootkit Scan
```
Launch a background Task agent with this prompt:

"You are running an rkhunter rootkit scan on this Linux server.

1. Update rkhunter signatures:
   Run: sudo rkhunter --update 2>&1

2. Run the rootkit scan:
   Run: sudo rkhunter --check --skip-keypress --report-warnings-only 2>&1 | tee /tmp/rkhunter-audit-$(date +%Y%m%d).log

3. Also check the main log:
   Run: tail -100 /var/log/rkhunter.log 2>/dev/null

4. Analyze the results:
   - Look for any Warning entries
   - Note any suspicious files or configurations
   - For any detected issues, use WebFetch or WebSearch to research them

5. Report your findings in this format:
   ## rkhunter Scan Results
   **Scan Date:** [date]
   **Status:** [CLEAN / WARNINGS / INFECTED]

   ### Warnings Found
   | Category | File/Item | Warning | Severity |
   |----------|-----------|---------|----------|

   ### Research on Findings
   [Include research from web on any suspicious findings]

   ### Recommended Actions
   - [list of actions]
"
```

---

## PHASE 6: Generate Security Report

After analyzing logs and collecting agent results, generate a comprehensive report:

```
================================================================================
                    LINUX SERVER SECURITY AUDIT REPORT
================================================================================
Server: [hostname]
Date: [date]
Auditor: Claude Code Security Audit

================================================================================
SECTION 1: EXECUTIVE SUMMARY
================================================================================
- Total attack attempts detected: [X]
- Unique malicious IPs identified: [Y]
- Currently banned by fail2ban: [Z]
- Malware/rootkit scan status: [CLEAN/INFECTED/PENDING]

================================================================================
SECTION 2: ATTACK ANALYSIS
================================================================================

### Attack Summary by Category
| Category              | Attempts | Unique IPs | Severity |
|-----------------------|----------|------------|----------|
| SSH Brute Force       | X        | Y          | HIGH     |
| WordPress Attacks     | X        | Y          | MEDIUM   |
| Web Shell Probing     | X        | Y          | CRITICAL |
| SQL Injection         | X        | Y          | CRITICAL |
| Path Traversal        | X        | Y          | HIGH     |
| Scanner Activity      | X        | Y          | LOW      |
| ...                   | ...      | ...        | ...      |

### Top 20 Threat IPs (Ranked by Danger)
| Rank | IP Address      | Attack Types        | Attempts | Country | Action      |
|------|-----------------|---------------------|----------|---------|-------------|
| 1    | X.X.X.X         | SSH, WordPress, SQL | NN       | [?]     | BAN 1 MONTH |
| ...  | ...             | ...                 | ...      | ...     | ...         |

### Sample Attack Log Entries
[Include 5-10 representative malicious log entries for documentation]

================================================================================
SECTION 3: FAIL2BAN BLOCKING COMMANDS
================================================================================

Execute these commands to ban the top threat IPs for 1 month (2592000 seconds):

```bash
# Ban top threat IPs across all jails
fail2ban-client set sshd banip X.X.X.X
# ... for each IP

# If you need to set custom ban time for specific IPs:
# fail2ban-client set sshd bantime 2592000

# Alternative: Direct iptables blocking (if fail2ban unavailable)
iptables -I INPUT -s X.X.X.X -j DROP
# ... for each IP

# Save iptables rules
iptables-save > /etc/iptables.rules
```

================================================================================
SECTION 4: SECURITY SCANNER STATUS
================================================================================

| Tool       | Installed | Version | Last Update | Status   |
|------------|-----------|---------|-------------|----------|
| ClamAV     | Yes/No    | X.X     | [date]      | OK/WARN  |
| chkrootkit | Yes/No    | X.X     | [date]      | OK/WARN  |
| rkhunter   | Yes/No    | X.X     | [date]      | OK/WARN  |

================================================================================
SECTION 5: MALWARE/ROOTKIT SCAN RESULTS
================================================================================

[Insert results from the 3 background agents here]

### ClamAV Results
[Agent 1 findings]

### chkrootkit Results
[Agent 2 findings]

### rkhunter Results
[Agent 3 findings]

================================================================================
SECTION 6: RECOMMENDED FAIL2BAN JAIL CONFIGURATION
================================================================================

If not already configured, add these jails to /etc/fail2ban/jail.local:

```ini
[apache-badbots]
enabled = true
port = http,https
filter = apache-badbots
logpath = /var/log/apache2/*access*.log
maxretry = 2
bantime = 2592000
findtime = 86400

[apache-noscript]
enabled = true
port = http,https
filter = apache-noscript
logpath = /var/log/apache2/*error*.log
maxretry = 3
bantime = 2592000

[apache-overflows]
enabled = true
port = http,https
filter = apache-overflows
logpath = /var/log/apache2/*error*.log
maxretry = 2
bantime = 2592000

[php-url-fopen]
enabled = true
port = http,https
filter = php-url-fopen
logpath = /var/log/apache2/*access*.log
maxretry = 1
bantime = 2592000

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 2592000
findtime = 600
```

================================================================================
SECTION 7: IMMEDIATE ACTION CHECKLIST
================================================================================

- [ ] Execute fail2ban commands above to ban top threats
- [ ] Review any infected files from ClamAV scan
- [ ] Investigate rootkit warnings from chkrootkit/rkhunter
- [ ] Update security tools if outdated
- [ ] Review and harden firewall rules
- [ ] Check for unauthorized SSH keys in /root/.ssh and /home/*/.ssh
- [ ] Review cron jobs for suspicious entries
- [ ] Check for suspicious processes: ps aux | grep -E "(nc|netcat|ncat|socat|cryptominer)"
- [ ] Review open ports: netstat -tlnp or ss -tlnp
- [ ] Schedule regular security audits (weekly cron job)
- [ ] Consider setting up intrusion detection (OSSEC, Wazuh, or similar)

================================================================================
                         END OF SECURITY AUDIT REPORT
================================================================================
```

---

## Important Notes

1. **Wait for background agents**: The 3 scanner agents run in parallel. Check their output files or use TaskOutput to get results before finalizing the report.

2. **IP Research**: For IPs showing sophisticated attack patterns, use WebSearch to check if they're part of known botnets or attack campaigns.

3. **False Positives**: Some legitimate services (monitoring, CDNs) may trigger alerts. Review before banning.

4. **Legal Compliance**: Ensure log retention and IP banning complies with local regulations.

5. **Documentation**: Save this report for incident response documentation.
