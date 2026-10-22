import { z } from "zod";
import { ComposeAuthoritySchema, ComposeCanonicalSchema, ComposeCapabilitiesSchema } from "./compose-recipe.js";
export const ComposeFullResourceIdSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const ComposeImageIdSchema=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha=z.string().regex(/^[a-f0-9]{64}$/),Name=z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const Text=z.string().max(8192),Args=z.array(z.string().max(16000)).max(100);
const Strings=z.array(Text).max(100),EmptyList=z.array(z.unknown()).length(0).nullable();
const EmptyMap=z.record(z.string(),z.unknown()).refine(v=>Object.keys(v).length===0).nullable();
const Labels=z.record(z.string().max(200),z.string().max(8192)).refine(v=>Object.keys(v).length<=200);
const Env=z.array(z.string().max(65737)).max(200).nullable();
const PortBinding=z.object({HostIp:z.literal("127.0.0.1"),HostPort:z.string().regex(/^[0-9]{1,5}$/)}).strict();
export const ComposePortBindingsSchema=z.record(z.string().regex(/^[0-9]{1,5}\/tcp$/),z.array(PortBinding).max(1).nullable()).refine(v=>Object.keys(v).length<=100);
const Bind=z.object({Type:z.literal("bind"),Source:Text,Target:Text,ReadOnly:z.boolean(),BindOptions:z.object({Propagation:z.literal("rprivate").optional(),CreateMountpoint:z.literal(false).optional()}).strict().optional()}).strict();
export const ComposeEngineBaselineSchema=z.object({
 Runtime:z.literal("runc"),IpcMode:z.literal("private"),CgroupnsMode:z.literal("private"),ShmSize:z.number().int().min(0).max(1073741824),
 LogConfig:z.object({Type:z.enum(["json-file","local"]),Config:z.record(z.string().max(200),z.string().max(2000)).refine(v=>Object.keys(v).length<=20)}).strict(),
 MaskedPaths:Strings.min(1),ReadonlyPaths:Strings.min(1),MemorySwappiness:z.number().int().min(-1).max(100).nullable(),PidsLimit:z.union([z.literal(0),z.literal(-1),z.null()]),
}).strict();
export const ComposeHostConfigSchema=ComposeEngineBaselineSchema.extend({
 Privileged:z.literal(false),ReadonlyRootfs:z.literal(true),PublishAllPorts:z.literal(false),AutoRemove:z.literal(false),
 CapAdd:EmptyList,CapDrop:z.tuple([z.literal("ALL")]),SecurityOpt:z.tuple([z.literal("no-new-privileges:true")]),
 PidMode:z.literal(""),UTSMode:z.literal(""),UsernsMode:z.literal(""),NetworkMode:Text,
 RestartPolicy:z.object({Name:z.literal("no"),MaximumRetryCount:z.literal(0)}).strict(),
 Binds:EmptyList,Mounts:z.array(Bind).max(100),PortBindings:ComposePortBindingsSchema,
 Tmpfs:EmptyMap,VolumesFrom:EmptyList,VolumeDriver:z.literal(""),Links:EmptyList,
 Devices:EmptyList,DeviceRequests:EmptyList,DeviceCgroupRules:EmptyList,Dns:EmptyList,DnsOptions:EmptyList,DnsSearch:EmptyList,ExtraHosts:EmptyList,GroupAdd:EmptyList,
 Ulimits:EmptyList,Sysctls:EmptyMap,StorageOpt:EmptyMap,Cgroup:z.literal(""),CgroupParent:z.literal(""),ContainerIDFile:z.literal(""),
 CpuShares:z.literal(0),Memory:z.literal(0),NanoCpus:z.literal(0),MemoryReservation:z.literal(0),MemorySwap:z.literal(0),
 CpuPeriod:z.literal(0),CpuQuota:z.literal(0),CpuRealtimePeriod:z.literal(0),CpuRealtimeRuntime:z.literal(0),CpusetCpus:z.literal(""),CpusetMems:z.literal(""),
 BlkioWeight:z.literal(0),BlkioWeightDevice:EmptyList,BlkioDeviceReadBps:EmptyList,BlkioDeviceWriteBps:EmptyList,BlkioDeviceReadIOps:EmptyList,BlkioDeviceWriteIOps:EmptyList,
 OomKillDisable:z.union([z.literal(false),z.null()]),OomScoreAdj:z.literal(0),Init:z.union([z.literal(false),z.null()]).optional(),
 Isolation:z.enum(["","default"]),ConsoleSize:z.tuple([z.literal(0),z.literal(0)]),
 CpuCount:z.literal(0).optional(),CpuPercent:z.literal(0).optional(),IOMaximumIOps:z.literal(0).optional(),IOMaximumBandwidth:z.literal(0).optional(),
 KernelMemory:z.literal(0).optional(),KernelMemoryTCP:z.literal(0).optional(),
}).strict();
export const ComposeImageApprovalSchema=z.object({Id:ComposeImageIdSchema,RepoDigests:z.array(z.string().max(500)).max(100),Config:z.object({
 Env,Cmd:Args.nullable(),Entrypoint:Args.nullable(),User:z.string().max(200),WorkingDir:Text,Volumes:EmptyMap,Healthcheck:z.null().optional(),StopSignal:z.string().max(30).optional(),Labels:Labels.nullable(),
 ExposedPorts:z.record(z.string().regex(/^[0-9]{1,5}\/(tcp|udp|sctp)$/),z.object({}).strict()).nullable().refine(v=>v===null||Object.keys(v).length<=100),
}).strict()}).strict();
export const ComposeResourceIdentitySchema=z.object({
 installId:Name,labId:z.string().min(1).max(200),runId:z.string().regex(/^[a-f0-9]{32}$/),generation:z.number().int().positive(),fence:z.number().int().positive(),
 specSha256:Sha,nonceSha256:Sha,requestSha256:Sha,intentId:z.string().min(1).max(200),
}).strict();
export const ComposeResourceJournalSchema=z.object({
 identity:ComposeResourceIdentitySchema,engine:ComposeCapabilitiesSchema,state:z.enum(["issued","committed"]),
 containers:z.record(Name,ComposeFullResourceIdSchema).refine(v=>Object.keys(v).length<=100),networkId:ComposeFullResourceIdSchema.nullable(),
}).strict();
export const ComposeResourceApprovalSchema=z.object({authority:ComposeAuthoritySchema,canonical:ComposeCanonicalSchema,images:z.record(Name,ComposeImageApprovalSchema),engineBaseline:ComposeEngineBaselineSchema,appArmorProfile:Text}).strict();
const ActualMount=z.object({Type:z.literal("bind"),Source:Text,Destination:Text,Mode:z.string().max(20),RW:z.boolean(),Propagation:z.literal("rprivate")}).strict();
const Attachment=z.object({NetworkID:ComposeFullResourceIdSchema,EndpointID:z.union([ComposeFullResourceIdSchema,z.literal("")]),Aliases:Strings.nullable().optional(),
 IPAMConfig:z.null().optional(),Links:EmptyList.optional(),DriverOpts:EmptyMap.optional(),
 Gateway:Text.optional(),IPAddress:Text.optional(),IPPrefixLen:z.number().int().optional(),IPv6Gateway:Text.optional(),GlobalIPv6Address:Text.optional(),GlobalIPv6PrefixLen:z.number().int().optional(),MacAddress:Text.optional(),DNSNames:Strings.optional(),GwPriority:z.literal(0).optional(),
}).strict();
export const ComposeContainerInspectSchema=z.object({Id:ComposeFullResourceIdSchema,Name:Text,Image:ComposeImageIdSchema,Path:Text,Args,AppArmorProfile:Text,
 Config:z.object({Image:z.string().max(500),Env,Cmd:Args.nullable(),Entrypoint:Args.nullable(),User:z.string().max(200),WorkingDir:Text,Labels,
 Volumes:EmptyMap,Healthcheck:z.null().optional(),ExposedPorts:ComposeImageApprovalSchema.shape.Config.shape.ExposedPorts,
 Tty:z.literal(false),OpenStdin:z.literal(false),StdinOnce:z.literal(false),Domainname:z.literal(""),
 Hostname:Text.optional(),AttachStdin:z.literal(false).optional(),AttachStdout:z.boolean().optional(),AttachStderr:z.boolean().optional(),
 NetworkDisabled:z.literal(false).optional(),MacAddress:z.literal("").optional(),StopSignal:z.string().max(30).optional(),StopTimeout:z.number().int().min(0).max(120).optional(),
 OnBuild:EmptyList.optional(),Shell:Args.optional(),
 }).strict(),
 HostConfig:ComposeHostConfigSchema,Mounts:z.array(ActualMount).max(100),
 NetworkSettings:z.object({Networks:z.record(z.string().max(200),Attachment).refine(v=>Object.keys(v).length===1),Ports:ComposePortBindingsSchema}).passthrough(),
 State:z.object({Status:z.enum(["created","running","exited"]),Running:z.boolean(),Paused:z.literal(false),Restarting:z.literal(false),Dead:z.literal(false)}).passthrough(),
}).passthrough();
export const ComposeNetworkInspectSchema=z.object({Id:ComposeFullResourceIdSchema,Name:z.string().max(200),Driver:z.literal("bridge"),Scope:z.literal("local"),Internal:z.literal(false),Attachable:z.literal(false),Ingress:z.literal(false),EnableIPv6:z.literal(false),EnableIPv4:z.literal(true).optional(),
 Labels,Options:z.record(z.string(),z.string()).refine(v=>Object.keys(v).length===0),
 IPAM:z.object({Driver:z.literal("default"),Options:EmptyMap,Config:z.array(z.object({Subnet:Text,Gateway:Text,IPRange:Text.optional(),AuxiliaryAddresses:EmptyMap.optional()}).strict()).max(1)}).strict(),
 Containers:z.record(ComposeFullResourceIdSchema,z.object({Name:Text,EndpointID:ComposeFullResourceIdSchema,MacAddress:Text.optional(),IPv4Address:Text.optional(),IPv6Address:Text.optional()}).strict()).refine(v=>Object.keys(v).length<=100),
 ConfigOnly:z.literal(false).optional(),ConfigFrom:z.object({Network:z.literal("")}).strict().optional(),
}).passthrough();
export const ComposeResourceProofInputSchema=z.object({
 journal:ComposeResourceJournalSchema,current:ComposeResourceIdentitySchema,observedEngine:ComposeCapabilitiesSchema,approval:ComposeResourceApprovalSchema,
 containersJson:z.string().max(2*1024*1024),networkJson:z.string().max(1024*1024),
}).strict();
export const ComposeResourceProofResultSchema=z.object({state:z.enum(["verified","quarantine"]),code:z.enum(["exact_resources_match","invalid_input","identity_mismatch","resource_ids_uncommitted","approval_mismatch","image_mismatch","config_mismatch","mount_mismatch","port_mismatch","network_mismatch"]),containerCount:z.number().int().min(0).max(100),runtimeEnabled:z.literal(false)}).strict();

// Creation identity is immutable across owner-fence renewal; current identity still checks that fence.
const CreationIdentity=ComposeResourceIdentitySchema.omit({fence:true});
const ReceiptBase=z.object({operationId:z.string().min(1).max(200),kind:z.enum(["network","container"]),service:Name.nullable(),requestSha256:Sha,creation:CreationIdentity,engine:ComposeCapabilitiesSchema}).strict();
export const ComposeResourceCreationReceiptSchema=z.discriminatedUnion("state",[
 ReceiptBase.extend({state:z.literal("issued"),resourceId:z.null()}),
 ReceiptBase.extend({state:z.literal("committed"),resourceId:ComposeFullResourceIdSchema}),
]);
export const ComposeKnownResourceProofInputSchema=z.object({
 journal:z.object({identity:ComposeResourceIdentitySchema,engine:ComposeCapabilitiesSchema,runState:z.enum(["provisioning","uncertain","complete"]),receipts:z.array(ComposeResourceCreationReceiptSchema).max(202)}).strict(),
 current:ComposeResourceIdentitySchema,observedEngine:ComposeCapabilitiesSchema,approval:ComposeResourceApprovalSchema,
 selection:z.object({services:z.array(Name).max(100),networkPurpose:z.enum(["inspect","remove"])}).strict(),
 containersJson:z.string().max(2*1024*1024),networkJson:z.string().max(1024*1024),
}).strict();
export const ComposeKnownResourceProofResultSchema=z.object({
 state:z.enum(["verified_known","quarantine"]),code:ComposeResourceProofResultSchema.shape.code,containerCount:z.number().int().min(0).max(100),
 scope:z.literal("known_resources_only"),generationCompleteness:z.literal("not_proved"),readiness:z.literal("not_proved"),runDisposition:z.literal("unchanged"),authority:z.literal("none"),runtimeEnabled:z.literal(false),
}).strict();
