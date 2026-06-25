import { describe, expect, it } from 'vitest';
import { resolveTcpIngressTarget } from '../src/commands/tcp-ingress';

describe('tcp ingress listener resolution', () => {
  it('resolves a listener to the public host and port from env diagnose data', () => {
    const target = resolveTcpIngressTarget([
      {
        service: 'device-edge',
        provider: 'klipper',
        hostname: 'device-edge.example.test',
        external_hostname: null,
        external_ip: null,
        listeners: [
          { name: 'a1-gt06', port: 33400, state: 'ready', node_target_port: 31340 },
        ],
      },
    ], 'a1-gt06');

    expect(target).toMatchObject({
      service: 'device-edge',
      provider: 'klipper',
      host: 'device-edge.example.test',
      port: 33400,
    });
  });

  it('rejects duplicate listener names across services', () => {
    expect(() => resolveTcpIngressTarget([
      {
        service: 'device-edge-a',
        provider: 'aws-nlb',
        external_hostname: 'a.example.test',
        listeners: [{ name: 'devices', port: 33400, state: 'ready' }],
      },
      {
        service: 'device-edge-b',
        provider: 'aws-nlb',
        external_hostname: 'b.example.test',
        listeners: [{ name: 'devices', port: 33500, state: 'ready' }],
      },
    ], 'devices')).toThrow('ambiguous');
  });
});
