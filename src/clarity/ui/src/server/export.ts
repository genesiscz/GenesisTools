import { exportMonth, type MonthExport } from "../../../../azure-devops/lib/timelog/export";
import { TimeLogApi } from "../../../../azure-devops/timelog-api";
import { requireTimeLogConfig, requireTimeLogUser } from "../../../../azure-devops/utils";

export async function getExportData(month: number, year: number): Promise<MonthExport> {
    const adoConfig = requireTimeLogConfig();
    const adoUser = requireTimeLogUser(adoConfig);
    const adoApi = new TimeLogApi(adoConfig.orgId!, adoConfig.projectId, adoConfig.timelog!.functionsKey, adoUser);

    return exportMonth(adoApi, month, year, adoUser.userId);
}
