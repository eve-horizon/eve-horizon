import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { agentRuntimePodQueries, orgQueries } from '@eve/db';
import {
  type AgentRuntimeHeartbeatRequest,
  type AgentRuntimePod,
  type AgentRuntimeStatusResponse,
} from '@eve/shared';

@Injectable()
export class AgentRuntimeService {
  private pods: ReturnType<typeof agentRuntimePodQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.pods = agentRuntimePodQueries(db);
    this.orgs = orgQueries(db);
  }

  async listStatus(orgId: string): Promise<AgentRuntimeStatusResponse> {
    const pods = await this.pods.listByOrg(orgId);
    const ttlMs = parseInt(process.env.AGENT_RUNTIME_HEARTBEAT_TTL_MS ?? '45000', 10);
    const now = Date.now();
    return {
      pods: pods.map((pod) => {
        const stale = now - pod.last_heartbeat_at.getTime() > ttlMs;
        return {
          ...this.toPodResponse(pod),
          stale,
        };
      }),
    };
  }

  async recordHeartbeat(
    orgId: string,
    payload: AgentRuntimeHeartbeatRequest,
  ): Promise<AgentRuntimePod> {
    const org = await this.orgs.findById(orgId);
    if (!org) {
      throw new NotFoundException(
        `Org '${orgId}' does not exist. ` +
        `Set EVE_ORG_ID to your org's actual ID, or leave it unset for auto-discovery. ` +
        `Check available orgs: SELECT id FROM orgs`,
      );
    }

    const now = new Date();
    const pod = await this.pods.upsert({
      org_id: orgId,
      pod_name: payload.pod_name,
      status: payload.status ?? 'healthy',
      capacity: payload.capacity ?? 0,
      last_heartbeat_at: now,
    });

    return this.toPodResponse(pod);
  }

  async listOrgIds(): Promise<string[]> {
    const orgs = await this.orgs.list({ limit: 50 });
    return orgs.map((org) => org.id);
  }

  private toPodResponse(pod: {
    org_id: string;
    pod_name: string;
    status: string;
    capacity: number;
    last_heartbeat_at: Date;
    created_at: Date;
    updated_at: Date;
  }): AgentRuntimePod {
    return {
      org_id: pod.org_id,
      pod_name: pod.pod_name,
      status: pod.status,
      capacity: pod.capacity,
      last_heartbeat_at: pod.last_heartbeat_at.toISOString(),
      created_at: pod.created_at.toISOString(),
      updated_at: pod.updated_at.toISOString(),
    };
  }
}
