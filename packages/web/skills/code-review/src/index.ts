export const CodeReviewSkill = {
  id: 'code-review',
  name: 'Code Review',
  description: 'Perform comprehensive code review',
  triggers: ['code_review', 'review_code', 'check_code'],
  
  systemPrompt: `You are an expert code reviewer. Analyze code for:
- Security vulnerabilities
- Performance issues
- Code style and best practices
- Potential bugs
- Documentation gaps

Provide actionable feedback with specific line references.`,

  tools: ['FileReadTool', 'GrepTool', 'GlobTool', 'CodeLintTool'],
  
  execute: async (context) => {
    return {
      summary: 'Code review completed',
      issues: [],
      suggestions: [],
    };
  },
};

export default CodeReviewSkill;
