@minLength(71)
@maxLength(71)
param digest string
param expires string
param testerOid string
param webClientId string
@secure()
param webClientSecret string
param modelEndpoint string
param modelDeployment string

resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: 'test-runtime' }
resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: 'synthetic-test' }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: 'iptest${uniqueString(resourceGroup().id)}' }
var appName = 'studio-test'
var origin = 'https://${appName}.${env.properties.defaultDomain}'
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: resourceGroup().location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${runtime.id}': {} } }
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 5187, allowInsecure: false, transport: 'http' }
      registries: [{ server: registry.properties.loginServer, identity: runtime.id }]
      secrets: [{ name: 'entra-web', value: webClientSecret }]
    }
    template: {
      scale: { minReplicas: 0, maxReplicas: 1 }
      volumes: [{ name: 'checkpoint', storageType: 'AzureFile', storageName: 'checkpoint', mountOptions: 'uid=1654,gid=1654,file_mode=0600,dir_mode=0700' }]
      containers: [{
        name: 'studio'
        image: '${registry.properties.loginServer}/interview-prep@${digest}'
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        volumeMounts: [{ volumeName: 'checkpoint', mountPath: '/staging' }]
        env: [
          { name: 'INTERVIEW_PREP_PLANE', value: 'private-test' }
          { name: 'INTERVIEW_PREP_PUBLIC_ORIGIN', value: origin }
          { name: 'INTERVIEW_PREP_TEST_EXPIRES', value: expires }
          { name: 'INTERVIEW_PREP_TESTER_OID', value: testerOid }
          { name: 'INTERVIEW_PREP_TENANT_ID', value: tenant().tenantId }
          { name: 'INTERVIEW_PREP_WEB_CLIENT_ID', value: webClientId }
          { name: 'INTERVIEW_PREP_WEB_CLIENT_SECRET', secretRef: 'entra-web' }
          { name: 'INTERVIEW_PREP_TEST_SHARE', value: '/staging' }
          { name: 'INTERVIEW_PREP_AZURE_OPENAI_ENDPOINT', value: modelEndpoint }
          { name: 'INTERVIEW_PREP_MODEL_ID', value: modelDeployment }
          { name: 'INTERVIEW_PREP_MODEL_CLIENT_ID', value: runtime.properties.clientId }
        ]
      }]
    }
  }
}
output origin string = origin
