export const DocumentationSkill = {
  id: 'documentation',
  name: 'Documentation Generator',
  description: 'Generate comprehensive documentation for code',
  triggers: ['generate_docs', 'create_documentation', 'document_code'],
  
  systemPrompt: `You are a documentation expert. Generate clear, comprehensive documentation including:
- API documentation
- Usage examples
- Installation instructions
- Configuration options
- Type definitions`,

  tools: ['FileReadTool', 'FileWriteTool', 'GlobTool', 'GrepTool'],
  
  execute: async (context) => {
    return {
      filesGenerated: [],
      coverage: 0,
    };
  },
};

export default DocumentationSkill;
