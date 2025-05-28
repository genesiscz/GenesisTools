# My IntelliJ (WebStorm) options:

Fine-tuned for my M4 MAX, 128G memory beast, these are the VM variables I use for WebStorm usage:

```
# === Memory Settings ===
# Initial heap size - Start with a generous amount
-Xms8g
# Maximum heap size - Allocate a significant portion for IDE activities
# 12g is a good balance; you can go higher (e.g., 16g, 24g) if monitoring shows benefits.
# Avoid setting it excessively high (like >64g) as it can sometimes increase GC pause times in large heaps.
-Xmx12g
# Size of the JIT compiled code cache. 1g is plenty.
-XX:ReservedCodeCacheSize=1g

# === Garbage Collection (G1) ===
# Use the modern Garbage First (G1) Garbage Collector
-XX:+UseG1GC
# Goal for maximum GC pause time in milliseconds. Helps keep the UI responsive.
-XX:MaxGCPauseMillis=100
# Percentage of the heap occupied before a concurrent GC cycle is initiated.
# 35% starts collection relatively early, giving G1 more time to complete before the heap fills.
-XX:InitiatingHeapOccupancyPercent=35
# Process soft, weak, and phantom references in parallel.
-XX:+ParallelRefProcEnabled
# Disable explicit System.gc() calls which can disrupt G1's cycles
-XX:+DisableExplicitGC

# === JVM Optimizations ===
# Use compressed pointers (enabled by default on 64-bit with heaps < 32GB, explicit is fine)
-XX:+UseCompressedOops
# Help manage the code cache effectively
-XX:+UseCodeCacheFlushing
# Pages the entire heap into memory on startup. Useful with abundant RAM.
-XX:+AlwaysPreTouch
# Enable tiered compilation (default and highly beneficial)
-XX:+TieredCompilation
# Enable Escape Analysis (default and beneficial)
-XX:+DoEscapeAnalysis
# Deduplicate identical String objects in the heap
-XX:+UseStringDeduplication
# Optimize String concatenation operations
-XX:+OptimizeStringConcat
# Number of compiler threads for the JIT. Adjust based on CPU cores if needed, 12 is fine.
-XX:CICompilerCount=12

# === Error Reporting and Logging ===
# Dump the heap on OutOfMemoryError - useful for debugging
-XX:+HeapDumpOnOutOfMemoryError
# Path for fatal error logs
-XX:ErrorFile=$USER_HOME/java_error_in_idea_%p.log
# Path for heap dump file
-XX:HeapDumpPath=$USER_HOME/java_error_in_idea.hprof
# Ensures full stack traces for frequently thrown exceptions
-XX:-OmitStackTraceInFastThrow

# === System Properties ===
# Ensure file encoding is UTF-8
-Dfile.encoding=UTF-8
# Enable assertions (usually enabled by default in development builds)
-ea
# Prevent issues with canonical path resolution
-Dsun.io.useCanonCaches=false
# Prefer IPv4 stack - helpful if IPv6 is misconfigured or problematic
-Djava.net.preferIPv4Stack=true
# Allow illegal access for complex applications (often needed by IDEs)
-Djdk.module.illegalAccess.permit=true
```

## Reasoning: 

My previous VM Options were:

```
-Xms8g
-XX:ReservedCodeCacheSize=2g
-XX:+UseG1GC
-XX:SoftRefLRUPolicyMSPerMB=50
-XX:CICompilerCount=12
-XX:G1HeapRegionSize=16m
-XX:MaxGCPauseMillis=100
-XX:InitiatingHeapOccupancyPercent=35
-XX:+ParallelRefProcEnabled
-XX:+UseStringDeduplication
-XX:+OptimizeStringConcat
-XX:+UseNUMA
-XX:+UseLargePages
-Xmx12g
-Djdk.module.illegalAccess.permit=true
```

The creator of WebPack [has suggested those](https://readmedium.com/speeding-up-intellij-webstorm-and-other-jetbrains-products-96a2abe6bf2):

```
-Xms1024m
-Xmx3072m
-Xss64m
-XX:ReservedCodeCacheSize=512m
-XX:+UseCompressedOops
-XX:NewRatio=2
-Dfile.encoding=UTF-8
-XX:+UseConcMarkSweepGC
-XX:SoftRefLRUPolicyMSPerMB=250
-XX:NewSize=512m
-XX:MaxNewSize=512m
-XX:PermSize=512m
-XX:MaxPermSize=1024m
-XX:+UseParNewGC
-XX:ParallelGCThreads=4
-XX:MaxTenuringThreshold=1
-XX:SurvivorRatio=8
-XX:+UseCodeCacheFlushing
-XX:+AggressiveOpts
-XX:+CMSClassUnloadingEnabled
-XX:+CMSIncrementalMode
-XX:+CMSIncrementalPacing
-XX:+CMSParallelRemarkEnabled
-XX:CMSInitiatingOccupancyFraction=65
-XX:+CMSScavengeBeforeRemark
-XX:+UseCMSInitiatingOccupancyOnly
-XX:-TraceClassUnloading
-XX:+AlwaysPreTouch
-XX:+TieredCompilation
-XX:+DoEscapeAnalysis
-XX:+UnlockExperimentalVMOptions
-XX:LargePageSizeInBytes=256m
-XX:+DisableExplicitGC
-XX:+ExplicitGCInvokesConcurrent
-XX:+PrintGCDetails
-XX:+PrintFlagsFinal
-XX:+HeapDumpOnOutOfMemoryError
-XX:+CMSPermGenSweepingEnabled
-XX:+UseAdaptiveGCBoundary
-XX:+UseSplitVerifier
-XX:CompileThreshold=10000
-XX:+UseCompressedStrings
-XX:+OptimizeStringConcat
-XX:+UseStringCache
-XX:+UseFastAccessorMethods
-XX:+UnlockDiagnosticVMOptions
-ea
-Dsun.io.useCanonCaches=false
-Djava.net.preferIPv4Stack=true
-XX:-OmitStackTraceInFastThrow
-Xverify:none

-XX:ErrorFile=$USER_HOME/java_error_in_idea_%p.log
-XX:HeapDumpPath=$USER_HOME/java_error_in_idea.hprof
-Dide.no.platform.update=true
```

That was written in 2019. With help from AI, I thrown away obsolete options, merged mine with his and fine tuned for my RAM size. 