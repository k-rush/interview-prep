targetScope = 'resourceGroup'

@allowed(['staging', 'production'])
param ring string
param sharedResourceGroup string
@description('Protected operator-built interview-prep-control SHA256 digest, never a tag.')
@minLength(71)
@maxLength(71)
param controllerDigest string

var suffix = uniqueString(subscription().subscriptionId, toLower(sharedResourceGroup))
var purposes = ['deploy', 'monitor']
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  scope: resourceGroup(sharedResourceGroup)
  name: 'ip${suffix}'
}
resource pull 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  scope: resourceGroup(sharedResourceGroup)
  name: '${ring}-pull'
}
resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for purpose in purposes: {
  scope: resourceGroup(sharedResourceGroup)
  name: '${ring}-ops-${purpose}'
}]
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'demo-${ring}'
  location: resourceGroup().location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

// Infrastructure updates never set the serving app image or route. Only a verified promotion creates it.
resource jobs 'Microsoft.App/jobs@2024-03-01' = [for (purpose, i) in purposes: {
  name: 'ops-${purpose}'
  location: resourceGroup().location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identities[i].id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registry.properties.loginServer, identity: identities[i].id }]
    }
    template: {
      containers: [{
        name: 'control'
        image: '${registry.properties.loginServer}/interview-prep-control@${controllerDigest}'
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'PURPOSE', value: purpose }
          { name: 'RING', value: ring }
          { name: 'CLIENT_ID', value: identities[i].properties.clientId }
          { name: 'APP_NAME', value: 'studio-${ring}' }
          { name: 'ENV_ID', value: environment.id }
          { name: 'DEFAULT_DOMAIN', value: environment.properties.defaultDomain }
          { name: 'PULL_ID', value: pull.id }
          { name: 'LOCATION', value: resourceGroup().location }
          { name: 'ACR_HOST', value: registry.properties.loginServer }
          { name: 'RECEIPT_STORE', value: 'ipr${suffix}' }
        ]
      }]
    }
  }
}]
