export const TestingSkill = {
  id: 'testing',
  name: 'Test Generator',
  description: 'Generate comprehensive tests for code',
  triggers: ['generate_tests', 'write_tests', 'create_tests'],
  
  systemPrompt: `You are a testing expert. Generate comprehensive tests including:
- Unit tests
- Integration tests
- Edge cases
- Error handling tests
- Performance tests`,

  tools: ['FileReadTool', 'FileWriteTool', 'GlobTool', 'CodeTestTool'],
  
  execute: async (context) => {
    return {
      testsGenerated: 0,
      coverage: 0,
    };
  },
};

export default TestingSkill;
