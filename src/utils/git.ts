export async function getGitRemoteUrls(): Promise<{ fetchUrl?: string; pushUrl?: string }> {
    try {
        const gitRemoteResult = await Bun.$`git remote -v`.text();
        const lines = gitRemoteResult.split('\n').filter(line => line.trim() !== '');

        let fetchUrl: string | undefined;
        let pushUrl: string | undefined;

        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 2 && parts[0] === 'origin') {
                const url = parts[1];
                const type = parts[2];
                if (type === '(fetch)') {
                    fetchUrl = url;
                } else if (type === '(push)') {
                    pushUrl = url;
                }
            }
        }

        if (!fetchUrl && !pushUrl) {
            console.warn("No git remote 'origin' found.");
        }

        return { fetchUrl, pushUrl };
    } catch (error) {
        console.error("Error getting git remote URLs:", error);
        return {};
    }
}
