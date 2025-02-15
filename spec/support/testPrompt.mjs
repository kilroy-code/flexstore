export function testPrompt (tag, promptString) { // Used when first creating a user credential, or when adding an existing credential to a new device.
  function swizzle(seed) { return seed + 'appSalt'; } // Could also look up in an app-specific customer database.
  if (promptString) return swizzle(promptString); // fixme prompt(promptString)); 
  return swizzle(tag);
};
