import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import JSZip from 'jszip';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../../src/modules/ai/agent/skill.service';
import { SkillController } from '../../src/modules/ai/agent/skill.controller';

describe('skill ZIP HTTP transport', () => {
  let app: INestApplication, root: string;
  const env = process.env['SKYALYTICWING_SKILLS_DIR'];
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wing-zip-http-')); process.env['SKYALYTICWING_SKILLS_DIR'] = root;
    const service = new SkillService({ info() {}, warn() {} } as any, { isPathAllowed: () => true, addAllowedPath() {} } as any);
    (service as any).skillsRoot = root; service.onModuleInit();
    const module = await Test.createTestingModule({ controllers: [SkillController], providers: [{ provide: SkillService, useValue: service }] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.init();
  });
  afterAll(async () => { await app?.close(); if (env === undefined) delete process.env['SKYALYTICWING_SKILLS_DIR']; else process.env['SKYALYTICWING_SKILLS_DIR'] = env; rmSync(root, { recursive: true, force: true }); });
  it('accepts multipart ZIP and downloads a real ZIP with preserved binary assets', async () => {
    const zip = new JSZip(); zip.file('example/SKILL.md', '# Example'); zip.file('example/assets/picture.bin', Buffer.from([0, 255, 8]));
    const imported = await request(app.getHttpServer()).post('/api/skills/import-zip').attach('file', await zip.generateAsync({ type: 'nodebuffer' }), 'example.zip').expect(201);
    expect(imported.body.data.skill.name).toBe('example');
    const result = await request(app.getHttpServer()).get('/api/skills/example/export-zip').buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200).expect('Content-Type', /application\/zip/);
    expect(result.headers['content-disposition']).toContain('example.zip');
    const output = await JSZip.loadAsync(result.body);
    expect(await output.file('example/assets/picture.bin')!.async('nodebuffer')).toEqual(Buffer.from([0, 255, 8]));
  });
  it('rejects non-ZIP input without creating a skill', async () => {
    await request(app.getHttpServer()).post('/api/skills/import-zip').attach('file', Buffer.from('text'), 'wrong.txt').expect(400);
  });
});
