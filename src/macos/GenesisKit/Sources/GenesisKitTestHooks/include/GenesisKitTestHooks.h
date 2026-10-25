#import <Foundation/Foundation.h>

/// The number of times a test asked for a key window or app activation that the hooks turned down. A test file
/// references it, which also keeps this object file (and its load-time hook) in the test bundle.
NSInteger GenesisKitTestHooksRefusedFocus(void);
