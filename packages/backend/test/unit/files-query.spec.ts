import 'reflect-metadata';
import { FilesController } from '../../src/modules/tools/files/files.controller.js';

describe('FilesController query decoding', () => {
  it.each(['E:/work/100% complete', 'E:/work/literal%2Fname'])('保留 Express 已解码的路径 %s', (path) => {
    const files = {
      tree: jest.fn(), serve: jest.fn().mockReturnValue({ stream: 'stream' }),
      gitChanges: jest.fn(), resolveProjectDir: jest.fn(), clearProjectDir: jest.fn(),
    };
    const controller = new FilesController(files as any);
    controller.tree(path);
    controller.serve(path);
    controller.gitChanges(path);
    controller.getProject(path);
    controller.clearProject(path);
    expect(files.tree).toHaveBeenCalledWith(path, undefined);
    expect(files.serve).toHaveBeenCalledWith(path);
    expect(files.gitChanges).toHaveBeenCalledWith(path);
    expect(files.resolveProjectDir).toHaveBeenCalledWith(path);
    expect(files.clearProjectDir).toHaveBeenCalledWith(path);
  });
});
