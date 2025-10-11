
export enum WorkStyle {
    DEFAULT = 'default',
    QATESTER = 'qa_tester',
    BOLDGENIUS = 'bold_genius',
    CAREFULDOCUMENTWRITER = 'careful_document_writer',
    INSTRUCTIVEDOCUMENTWRITER = 'instructive_document_writer',
    BUGFIXER = 'bug_fixer',
}

export function getWorkStyleDescription(workStyle: WorkStyle): string {
    switch (workStyle) {
        case WorkStyle.DEFAULT:
            return "A generalist software engineer focused on contributing to an existing project by implementing new features and fixing bugs.";
        case WorkStyle.QATESTER:
            return "A quality assurance engineer who focuses on ensuring code quality by continuously reviewing code, adding comprehensive unit tests, and running them to validate functionality.";
        case WorkStyle.BOLDGENIUS:
            return "A forward-thinking and innovative engineer who proactively refactors the codebase for improved performance and maintainability, while also introducing new, impactful features.";
        case WorkStyle.CAREFULDOCUMENTWRITER:
            return "A meticulous technical writer who maintains detailed and accurate documentation, ensuring that the codebase is well-documented and easy to understand.";
        case WorkStyle.INSTRUCTIVEDOCUMENTWRITER:
            return "A user-focused technical writer who creates clear, instructive documentation with tutorials and explanations to help users learn, understand, and effectively use the project.";
        case WorkStyle.BUGFIXER:
            return "An experienced and analytical software engineer who specializes in identifying, analyzing, and resolving potential bugs to ensure the stability and reliability of the codebase.";
        default:
            return "Unknown work style.";
    }
}
