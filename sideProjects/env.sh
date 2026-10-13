export JAVA_HOME=/home/hatch/workspace/tools/jdk/jdk-17.0.20.1+1
export ANDROID_HOME=/home/hatch/workspace/tools/android-sdk
export ANDROID_SDK_ROOT=/home/hatch/workspace/tools/android-sdk
export PATH=/home/hatch/workspace/tools/gradle/gradle-8.9/bin:$PATH
P="$https_proxy"
PU=$(echo "$P" | sed -E 's|http://([^:]+):.*|\1|')
PP=$(echo "$P" | sed -E 's|http://[^:]+:([^@]+)@.*|\1|')
PH=$(echo "$P" | sed -E 's|http://[^@]+@([^:]+):.*|\1|')
PT=$(echo "$P" | sed -E 's|http://[^@]+@[^:]+:([0-9]+)|\1|')
export _JAVA_OPTIONS="-Djava.net.preferIPv4Stack=true -Dhttp.proxyHost=$PH -Dhttp.proxyPort=$PT -Dhttp.proxyUser=$PU -Dhttp.proxyPassword=$PP -Dhttps.proxyHost=$PH -Dhttps.proxyPort=$PT -Dhttps.proxyUser=$PU -Dhttps.proxyPassword=$PP -Dhttp.nonProxyHosts=localhost|127.0.0.1"

# Re-import the sandbox egress CA if this is a fresh JDK (VM replacements wipe it)
if [ -n "$JAVA_HOME" ] && [ -f ~/workspace/tools/hatch-egress-ca.pem ]; then
  $JAVA_HOME/bin/keytool -list -keystore $JAVA_HOME/lib/security/cacerts -storepass changeit -alias hatch-egress-ca >/dev/null 2>&1 || \
  $JAVA_HOME/bin/keytool -import -trustcacerts -alias hatch-egress-ca -file ~/workspace/tools/hatch-egress-ca.pem -keystore $JAVA_HOME/lib/security/cacerts -storepass changeit -noprompt >/dev/null 2>&1
fi
