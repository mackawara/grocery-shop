export const preparePlatformAdminPassword = async (
  setPassword: boolean,
  generatePassword: boolean,
  prompt: () => Promise<string>,
  generate: () => string,
): Promise<string | undefined> => {
  if (generatePassword) {
    return generate();
  }
  if (setPassword) {
    const password = (await prompt()).trim();
    if (!password) {
      throw new Error('No password supplied');
    }
    return password;
  }
  return undefined;
};
